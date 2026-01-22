const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fetch = require("node-fetch");
const archiver = require("archiver");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration Dropbox
const DROPBOX_CONFIG = {
  appKey: process.env.DROPBOX_APP_KEY || "REMPLACE_PAR_TON_APP_KEY",
  appSecret: process.env.DROPBOX_APP_SECRET || "REMPLACE_PAR_TON_APP_SECRET",
  refreshToken:
    process.env.DROPBOX_REFRESH_TOKEN || "REMPLACE_PAR_TON_REFRESH_TOKEN",
  useSharedFolder: false,
  sharedFolderId: "",
  uploadPath: "/test",
};

let accessToken = null;
let tokenExpiry = null;

// Augmenter les timeouts
app.use(cors());
app.use(express.json({ limit: "4gb" }));
app.use(express.urlencoded({ limit: "4gb", extended: true }));

// Timeout de 10 minutes pour les requêtes
app.use((req, res, next) => {
  req.setTimeout(600000); // 10 minutes
  res.setTimeout(600000);
  next();
});

// Servir les fichiers statiques (HTML, CSS, JS)
app.use(express.static(__dirname));

// Route pour la page d'accueil
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "upload.html"));
});

// Configuration Multer avec limite augmentée
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = "./uploads";
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}_${file.originalname}`);
  },
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 3 * 1024 * 1024 * 1024, // 3 GB
    files: 50, // Max 50 fichiers
  },
});

// Renouveler le token Dropbox
async function refreshAccessToken() {
  const now = Date.now();
  if (accessToken && tokenExpiry && now < tokenExpiry) {
    return accessToken;
  }

  try {
    const response = await fetch("https://api.dropbox.com/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: DROPBOX_CONFIG.refreshToken,
        client_id: DROPBOX_CONFIG.appKey,
        client_secret: DROPBOX_CONFIG.appSecret,
      }),
    });

    const data = await response.json();

    if (data.access_token) {
      accessToken = data.access_token;
      tokenExpiry = now + data.expires_in * 1000;
      console.log("✅ Token Dropbox renouvelé avec succès");
      return accessToken;
    } else {
      throw new Error("Impossible d'obtenir le token");
    }
  } catch (error) {
    console.error("❌ Erreur lors du renouvellement du token:", error);
    throw error;
  }
}

// Tester la connexion Dropbox
app.get("/test-connection", async (req, res) => {
  try {
    const token = await refreshAccessToken();

    const response = await fetch(
      "https://api.dropboxapi.com/2/users/get_current_account",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );

    const data = await response.json();

    if (response.ok) {
      res.json({
        success: true,
        message: `Connecté en tant que: ${data.name.display_name}\nEmail: ${data.email}`,
      });
    } else {
      res.json({
        success: false,
        message: `Erreur: ${data.error_summary || "Impossible de se connecter"}`,
      });
    }
  } catch (error) {
    res.json({
      success: false,
      message: `Erreur de connexion: ${error.message}`,
    });
  }
});

// Upload vers Dropbox avec meilleure gestion des chunks
async function uploadToDropbox(filePath, fileName, token) {
  const CHUNK_SIZE = 100 * 1024 * 1024; // 100 MB par chunk
  const fileSize = fs.statSync(filePath).size;
  const dropboxPath = `${DROPBOX_CONFIG.uploadPath}/${fileName}`;

  console.log(
    `📤 Upload de ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`,
  );

  if (fileSize <= CHUNK_SIZE) {
    const fileContent = fs.readFileSync(filePath);

    const response = await fetch(
      "https://content.dropboxapi.com/2/files/upload",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify({
            path: dropboxPath,
            mode: "add",
            autorename: true,
            mute: false,
          }),
        },
        body: fileContent,
        timeout: 600000, // 10 minutes timeout
      },
    );

    if (!response.ok) {
      throw new Error(`Erreur Dropbox: ${response.statusText}`);
    }

    return await response.json();
  } else {
    // Upload par chunks pour les gros fichiers
    const fileStream = fs.createReadStream(filePath, {
      highWaterMark: CHUNK_SIZE,
    });
    let sessionId = null;
    let offset = 0;
    let chunkNumber = 0;

    for await (const chunk of fileStream) {
      chunkNumber++;
      console.log(
        `  📦 Chunk ${chunkNumber} - ${(offset / 1024 / 1024).toFixed(2)} MB uploadés`,
      );

      if (!sessionId) {
        const startResponse = await fetch(
          "https://content.dropboxapi.com/2/files/upload_session/start",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/octet-stream",
            },
            body: chunk,
            timeout: 600000,
          },
        );

        if (!startResponse.ok) {
          throw new Error(
            `Erreur démarrage session: ${startResponse.statusText}`,
          );
        }

        const startData = await startResponse.json();
        sessionId = startData.session_id;
      } else {
        const appendResponse = await fetch(
          "https://content.dropboxapi.com/2/files/upload_session/append_v2",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/octet-stream",
              "Dropbox-API-Arg": JSON.stringify({
                cursor: { session_id: sessionId, offset: offset },
              }),
            },
            body: chunk,
            timeout: 600000,
          },
        );

        if (!appendResponse.ok) {
          throw new Error(`Erreur append chunk: ${appendResponse.statusText}`);
        }
      }
      offset += chunk.length;
    }

    console.log(`  ✅ Finalisation de l'upload...`);

    const finishResponse = await fetch(
      "https://content.dropboxapi.com/2/files/upload_session/finish",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify({
            cursor: { session_id: sessionId, offset: offset },
            commit: {
              path: dropboxPath,
              mode: "add",
              autorename: true,
              mute: false,
            },
          }),
        },
        timeout: 600000,
      },
    );

    if (!finishResponse.ok) {
      throw new Error(`Erreur finalisation: ${finishResponse.statusText}`);
    }

    return await finishResponse.json();
  }
}

// Route d'upload avec meilleure gestion
app.post("/upload", upload.array("files"), async (req, res) => {
  console.log("📥 Début de la requête d'upload");

  try {
    const files = req.files;
    const formData = req.body;

    if (!files || files.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Aucun fichier uploadé" });
    }

    console.log(`📁 ${files.length} fichier(s) reçu(s)`);

    const token = await refreshAccessToken();

    const date = new Date();
    const dateStr = date.toISOString().split("T")[0].replace(/-/g, "");
    const nom = formData.field1 || "inconnu";
    const prenom = formData.field2 || "inconnu";
    const morceau = formData.field5 || "projet";
    const archiveName = `${dateStr}_${nom}_${prenom}_${morceau}.zip`;
    const archivePath = `./uploads/${archiveName}`;

    console.log(`📦 Création du ZIP: ${archiveName}`);

    const output = fs.createWriteStream(archivePath);
    const archive = archiver("zip", {
      zlib: { level: 6 }, // Niveau de compression réduit pour plus de vitesse
    });

    archive.on("error", (err) => {
      throw err;
    });

    archive.pipe(output);

    files.forEach((file) => {
      console.log(`  ➕ Ajout: ${file.originalname}`);
      archive.file(file.path, { name: file.originalname });
    });

    let infoContent = "=== INFORMATIONS DU PROJET ===\n\n";
    infoContent += `Contact technique:\n`;
    infoContent += `- Nom: ${formData.field1}\n`;
    infoContent += `- Prénom: ${formData.field2}\n`;
    infoContent += `- Email: ${formData.field3}\n`;
    infoContent += `- Téléphone: ${formData.field4}\n\n`;
    infoContent += `Informations du morceau:\n`;
    infoContent += `- Nom du morceau: ${formData.field5}\n`;
    infoContent += `- Artiste: ${formData.field6}\n`;
    infoContent += `- BPM: ${formData.field7}\n`;
    infoContent += `- Signature rythmique: ${formData.field8}\n`;
    infoContent += `- Durée totale: ${formData.field9}\n\n`;
    infoContent += `Informations techniques:\n`;
    infoContent += `- Liste des stems: ${formData.field10}\n`;
    infoContent += `- Stems témoins: ${formData.field11}\n`;
    infoContent += `- Contraintes artistiques: ${formData.field12}\n`;

    archive.append(infoContent, { name: "informations.txt" });

    await archive.finalize();
    await new Promise((resolve) => output.on("close", resolve));

    console.log(
      `✅ ZIP créé (${(archive.pointer() / 1024 / 1024).toFixed(2)} MB)`,
    );

    console.log(`☁️ Upload vers Dropbox...`);
    const uploadResult = await uploadToDropbox(archivePath, archiveName, token);

    // Nettoyage des fichiers temporaires
    console.log(`🧹 Nettoyage...`);
    files.forEach((file) => {
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    });

    if (fs.existsSync(archivePath)) {
      fs.unlinkSync(archivePath);
    }

    console.log(`✅ Upload réussi: ${archiveName} (${files.length} fichiers)`);

    res.json({
      success: true,
      message: "Upload réussi",
      archiveName: archiveName,
      filesCount: files.length,
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
    });
  } catch (error) {
    console.error("❌ Erreur:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});
