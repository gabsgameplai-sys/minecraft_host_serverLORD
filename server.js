require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { OAuth2Client } = require("google-auth-library");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const JAVA_RAM_MIN = process.env.JAVA_RAM_MIN || "1G";
const JAVA_RAM_MAX = process.env.JAVA_RAM_MAX || "2G";
const JAVA_PATH = process.env.JAVA_PATH || "java";

const SERVER_DIR = path.resolve(__dirname, process.env.SERVER_DIR || "server-files");
const SERVER_JAR_NAME = process.env.SERVER_JAR || "server.jar";
const SERVER_JAR_PATH = path.join(SERVER_DIR, SERVER_JAR_NAME);
const SERVER_PROPERTIES_FILE = path.join(SERVER_DIR, "server.properties");
const PLUGINS_DIR = path.join(SERVER_DIR, "plugins");

const MAX_CONSOLE_LINES = 500;

let mcProcess = null;
let consoleLines = [];
let sessions = new Map();

app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

ensureDir(SERVER_DIR);
ensureDir(PLUGINS_DIR);

function addConsoleLine(message) {
  const line = `[${new Date().toLocaleString("pt-BR")}] ${message}`;
  consoleLines.push(line);
  if (consoleLines.length > MAX_CONSOLE_LINES) {
    consoleLines = consoleLines.slice(-MAX_CONSOLE_LINES);
  }
  console.log(line);
}

function parseProperties(raw) {
  const props = {};
  const lines = String(raw || "").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;

    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();

    props[key] = value;
  }

  return props;
}

function stringifyProperties(obj) {
  return Object.entries(obj)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n") + "\n";
}

function ensureServerPropertiesFile() {
  if (!fs.existsSync(SERVER_PROPERTIES_FILE)) {
    const defaults = {
      "motd": "Minecraft Server",
      "server-port": "25565",
      "max-players": "20",
      "online-mode": "true",
      "difficulty": "easy",
      "gamemode": "survival",
      "pvp": "true",
      "white-list": "false",
      "enable-command-block": "false",
      "hardcore": "false",
      "allow-nether": "true",
      "view-distance": "10",
      "simulation-distance": "10",
      "spawn-protection": "16",
      "level-seed": "",
      "level-name": "world"
    };

    fs.writeFileSync(SERVER_PROPERTIES_FILE, stringifyProperties(defaults), "utf8");
    addConsoleLine("server.properties criado automaticamente.");
  }
}

function readServerProperties() {
  ensureServerPropertiesFile();
  const raw = fs.readFileSync(SERVER_PROPERTIES_FILE, "utf8");
  return {
    raw,
    props: parseProperties(raw)
  };
}

function isServerRunning() {
  return mcProcess !== null;
}

function getLocalIPv4() {
  const nets = os.networkInterfaces();

  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }

  return "127.0.0.1";
}

function validateBooleanString(value, fallback = "false") {
  if (value === true || value === "true") return "true";
  if (value === false || value === "false") return "false";
  return fallback;
}

function validatePositiveNumberString(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return String(Math.floor(n));
  return String(fallback);
}

function sanitizeConfig(input, currentProps = {}) {
  const config = { ...currentProps };

  if ("motd" in input) config["motd"] = String(input["motd"] ?? "").trim();
  if ("gamemode" in input) config["gamemode"] = String(input["gamemode"] ?? "survival").trim();
  if ("difficulty" in input) config["difficulty"] = String(input["difficulty"] ?? "easy").trim();
  if ("max-players" in input) config["max-players"] = validatePositiveNumberString(input["max-players"], config["max-players"] || 20);
  if ("server-port" in input) config["server-port"] = validatePositiveNumberString(input["server-port"], config["server-port"] || 25565);
  if ("view-distance" in input) config["view-distance"] = validatePositiveNumberString(input["view-distance"], config["view-distance"] || 10);
  if ("simulation-distance" in input) config["simulation-distance"] = validatePositiveNumberString(input["simulation-distance"], config["simulation-distance"] || 10);
  if ("spawn-protection" in input) config["spawn-protection"] = validatePositiveNumberString(input["spawn-protection"], config["spawn-protection"] || 16);

  if ("pvp" in input) config["pvp"] = validateBooleanString(input["pvp"], config["pvp"] || "true");
  if ("online-mode" in input) config["online-mode"] = validateBooleanString(input["online-mode"], config["online-mode"] || "true");
  if ("white-list" in input) config["white-list"] = validateBooleanString(input["white-list"], config["white-list"] || "false");
  if ("enable-command-block" in input) config["enable-command-block"] = validateBooleanString(input["enable-command-block"], config["enable-command-block"] || "false");
  if ("hardcore" in input) config["hardcore"] = validateBooleanString(input["hardcore"], config["hardcore"] || "false");
  if ("allow-nether" in input) config["allow-nether"] = validateBooleanString(input["allow-nether"], config["allow-nether"] || "true");

  if ("level-seed" in input) config["level-seed"] = String(input["level-seed"] ?? "").trim();
  if ("level-name" in input) config["level-name"] = String(input["level-name"] ?? "world").trim() || "world";

  return config;
}

function startMinecraftProcess() {
  if (isServerRunning()) {
    return { ok: false, error: "O servidor já está em execução." };
  }

  if (!fs.existsSync(SERVER_JAR_PATH)) {
    return {
      ok: false,
      error: `Arquivo do servidor não encontrado: ${SERVER_JAR_NAME}`
    };
  }

  ensureServerPropertiesFile();

  addConsoleLine(`Iniciando servidor Minecraft com ${SERVER_JAR_NAME}...`);

  mcProcess = spawn(
    JAVA_PATH,
    [
      `-Xms${JAVA_RAM_MIN}`,
      `-Xmx${JAVA_RAM_MAX}`,
      "-jar",
      SERVER_JAR_NAME,
      "nogui"
    ],
    {
      cwd: SERVER_DIR,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  mcProcess.stdout.on("data", (data) => {
    const text = data.toString();
    text.split(/\r?\n/).filter(Boolean).forEach((line) => addConsoleLine(line));
  });

  mcProcess.stderr.on("data", (data) => {
    const text = data.toString();
    text.split(/\r?\n/).filter(Boolean).forEach((line) => addConsoleLine(`[ERRO] ${line}`));
  });

  mcProcess.on("close", (code) => {
    addConsoleLine(`Servidor Minecraft encerrado. Código: ${code}`);
    mcProcess = null;
  });

  mcProcess.on("error", (err) => {
    addConsoleLine(`Falha ao iniciar o servidor: ${err.message}`);
    mcProcess = null;
  });

  return { ok: true };
}

function stopMinecraftProcess() {
  if (!isServerRunning()) {
    return { ok: false, error: "O servidor não está em execução." };
  }

  try {
    mcProcess.stdin.write("stop\n");
    addConsoleLine("Comando stop enviado ao servidor.");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function restartMinecraftProcess() {
  if (!isServerRunning()) {
    return startMinecraftProcess();
  }

  try {
    mcProcess.stdin.write("stop\n");
    addConsoleLine("Reiniciando servidor...");

    const waitInterval = setInterval(() => {
      if (!isServerRunning()) {
        clearInterval(waitInterval);
        startMinecraftProcess();
      }
    }, 1500);

    setTimeout(() => {
      if (!isServerRunning()) {
        clearInterval(waitInterval);
        startMinecraftProcess();
      }
    }, 10000);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function listFilesRecursive(dir, baseDir = dir) {
  const result = [];

  if (!fs.existsSync(dir)) return result;

  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (item.isDirectory()) {
      result.push({
        name: item.name,
        path: relativePath.replace(/\\/g, "/"),
        type: "folder"
      });

      result.push(...listFilesRecursive(fullPath, baseDir));
    } else {
      const stat = fs.statSync(fullPath);
      result.push({
        name: item.name,
        path: relativePath.replace(/\\/g, "/"),
        type: "file",
        size: stat.size
      });
    }
  }

  return result;
}

function getTokenFromRequest(req) {
  const authHeader = req.headers.authorization || "";
  const headerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null;

  return (
    headerToken ||
    req.headers["x-auth-token"] ||
    req.query.token ||
    req.body?.token ||
    null
  );
}

function requireAuth(req, res, next) {
  const token = getTokenFromRequest(req);

  if (!token || !sessions.has(token)) {
    return res.status(401).json({ ok: false, error: "Não autenticado." });
  }

  req.user = sessions.get(token);
  next();
}

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    ensureDir(PLUGINS_DIR);
    cb(null, PLUGINS_DIR);
  },
  filename: function (_req, file, cb) {
    cb(null, file.originalname);
  }
});

const upload = multer({ storage });

app.post("/api/login", async (req, res) => {
  try {
    const { token } = req.body || {};

    if (!token) {
      return res.status(400).json({ ok: false, error: "Token do Google não enviado." });
    }

    if (!GOOGLE_CLIENT_ID) {
      return res.status(500).json({ ok: false, error: "GOOGLE_CLIENT_ID não configurado." });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();

    const sessionToken = crypto.randomBytes(32).toString("hex");

    const user = {
      name: payload?.name || "Usuário",
      email: payload?.email || "",
      picture: payload?.picture || ""
    };

    sessions.set(sessionToken, user);

    addConsoleLine(`Login realizado por ${user.email || user.name}`);

    res.json({
      ok: true,
      token: sessionToken,
      user
    });
  } catch (err) {
    res.status(401).json({
      ok: false,
      error: "Falha no login com Google."
    });
  }
});

app.get("/api/status", requireAuth, (req, res) => {
  try {
    const localIp = getLocalIPv4();
    const { props } = readServerProperties();

    res.json({
      ok: true,
      online: isServerRunning(),
      pid: mcProcess ? mcProcess.pid : null,
      panelUrl: `http://${localIp}:${PORT}`,
      localPanelUrl: `http://${localIp}:${PORT}`,
      localIp,
      minecraftHost: localIp,
      minecraftPort: Number(props["server-port"] || 25565),
      jar: SERVER_JAR_NAME,
      serverDir: SERVER_DIR
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/start", requireAuth, (req, res) => {
  const result = startMinecraftProcess();

  if (!result.ok) {
    return res.status(400).json(result);
  }

  res.json({ ok: true, message: "Servidor iniciado." });
});

app.post("/api/stop", requireAuth, (req, res) => {
  const result = stopMinecraftProcess();

  if (!result.ok) {
    return res.status(400).json(result);
  }

  res.json({ ok: true, message: "Servidor parando." });
});

app.post("/api/restart", requireAuth, (req, res) => {
  const result = restartMinecraftProcess();

  if (!result.ok) {
    return res.status(400).json(result);
  }

  res.json({ ok: true, message: "Reinício solicitado." });
});

app.get("/api/console", requireAuth, (_req, res) => {
  res.json({
    ok: true,
    log: consoleLines.slice(-200)
  });
});

app.post("/api/command", requireAuth, (req, res) => {
  try {
    if (!isServerRunning()) {
      return res.status(400).json({ ok: false, error: "Servidor offline." });
    }

    const command = String(req.body?.command || "").trim();

    if (!command) {
      return res.status(400).json({ ok: false, error: "Comando vazio." });
    }

    mcProcess.stdin.write(command + "\n");
    addConsoleLine(`[CMD ${req.user.email || req.user.name}] ${command}`);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/server-config", requireAuth, (_req, res) => {
  try {
    const { raw, props } = readServerProperties();

    res.json({
      ok: true,
      config: props,
      raw
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/server-config", requireAuth, (req, res) => {
  try {
    ensureServerPropertiesFile();

    const incoming = req.body?.config || req.body;

    if (!incoming || typeof incoming !== "object") {
      return res.status(400).json({
        ok: false,
        error: "Configuração inválida."
      });
    }

    const { props: currentProps } = readServerProperties();
    const newProps = sanitizeConfig(incoming, currentProps);

    fs.writeFileSync(
      SERVER_PROPERTIES_FILE,
      stringifyProperties(newProps),
      "utf8"
    );

    addConsoleLine(`Configurações alteradas por ${req.user.email || req.user.name}`);

    res.json({
      ok: true,
      message: isServerRunning()
        ? "Configuração salva. Reinicie o servidor para aplicar as alterações."
        : "Configuração salva com sucesso.",
      config: newProps
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/files", requireAuth, (_req, res) => {
  try {
    const files = listFilesRecursive(SERVER_DIR, SERVER_DIR);

    res.json({
      ok: true,
      files
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/upload-plugin", requireAuth, upload.single("plugin"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Nenhum arquivo enviado." });
    }

    addConsoleLine(`Plugin enviado: ${req.file.originalname}`);

    res.json({
      ok: true,
      file: {
        name: req.file.originalname,
        path: `plugins/${req.file.originalname}`,
        size: req.file.size
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/", (_req, res) => {
  const indexPath = path.join(__dirname, "index.html");

  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  res.send("Servidor rodando.");
});

app.listen(PORT, HOST, () => {
  ensureServerPropertiesFile();
  addConsoleLine(`Painel iniciado em http://localhost:${PORT}`);
});
