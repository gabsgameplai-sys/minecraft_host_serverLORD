require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const { spawn } = require("child_process");
const { OAuth2Client } = require("google-auth-library");
const { WebcastPushConnection } = require("tiktok-live-connector");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID ||
  "735004448085-15s049l8cd9ged1d9gva134t8hoc39gm.apps.googleusercontent.com";

const JAVA_RAM_MIN = process.env.JAVA_RAM_MIN || "1G";
const JAVA_RAM_MAX = process.env.JAVA_RAM_MAX || "2G";
const JAVA_PATH = process.env.JAVA_PATH || "java";

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

app.use(
  cors({
    origin: true,
    credentials: false,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

app.options("*", cors());
app.use(express.json({ limit: "15mb" }));

const SERVER_DIR = path.join(__dirname, "server-files");
const PLUGINS_DIR = path.join(SERVER_DIR, "plugins");
const SERVER_JAR = path.join(SERVER_DIR, "server.jar");
const SERVER_PROPERTIES_FILE = path.join(SERVER_DIR, "server.properties");
const EULA_FILE = path.join(SERVER_DIR, "eula.txt");
const USERS_FILE = path.join(__dirname, "users.json");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const AVATARS_DIR = path.join(UPLOADS_DIR, "avatars");
const TIKTOK_RULES_FILE = path.join(__dirname, "tiktok-rules.json");

if (!fs.existsSync(SERVER_DIR)) fs.mkdirSync(SERVER_DIR, { recursive: true });
if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });

app.use("/uploads", express.static(UPLOADS_DIR));
app.use(express.static(__dirname));

/* =========================
   LOG
========================= */

let mcProcess = null;
let consoleBuffer = ["[INFO] Backend iniciado."];

function addConsoleLine(text) {
  const time = new Date().toLocaleTimeString("pt-BR");
  const line = `[${time}] ${text}`;
  consoleBuffer.push(line);

  if (consoleBuffer.length > 1000) {
    consoleBuffer = consoleBuffer.slice(-1000);
  }

  console.log(line);
}

/* =========================
   USERS
========================= */

function ensureUsersFile() {
  try {
    if (!fs.existsSync(USERS_FILE)) {
      const defaultUsers = {
        users: [
          { username: "adminLord", password: "123456", avatarUrl: "" },
          { username: "adminSassdio", password: "123456", avatarUrl: "" }
        ]
      };

      fs.writeFileSync(
        USERS_FILE,
        JSON.stringify(defaultUsers, null, 2),
        "utf8"
      );

      addConsoleLine("Arquivo users.json criado automaticamente.");
    }
  } catch (err) {
    addConsoleLine("Erro ao criar users.json: " + err.message);
  }
}

function readUsers() {
  ensureUsersFile();

  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (!parsed.users || !Array.isArray(parsed.users)) {
      return { users: [] };
    }

    parsed.users = parsed.users.map((user) => ({
      avatarUrl: "",
      ...user
    }));

    return parsed;
  } catch (err) {
    addConsoleLine("Erro ao ler users.json: " + err.message);
    return { users: [] };
  }
}

function writeUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), "utf8");
}

function findUser(username) {
  const db = readUsers();
  return db.users.find((u) => u.username === username) || null;
}

ensureUsersFile();

/* =========================
   SERVER.PROPERTIES / EULA
========================= */

function parseProperties(content) {
  const result = {};
  const lines = String(content).split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();

    result[key] = value;
  }

  return result;
}

function stringifyProperties(obj) {
  return Object.entries(obj)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function ensureServerPropertiesFile() {
  if (!fs.existsSync(SERVER_PROPERTIES_FILE)) {
    const defaultProps = [
      "motd=Meu Servidor Minecraft",
      "gamemode=survival",
      "difficulty=easy",
      "pvp=true",
      "online-mode=true",
      "max-players=20",
      "white-list=false",
      "enable-command-block=false",
      "spawn-protection=16",
      "view-distance=10",
      "simulation-distance=10",
      "allow-nether=true",
      "hardcore=false",
      "generate-structures=true",
      "level-seed=",
      "level-name=world",
      "server-port=25565"
    ].join("\n");

    fs.writeFileSync(SERVER_PROPERTIES_FILE, defaultProps, "utf8");
    addConsoleLine("Arquivo server.properties criado automaticamente.");
  }
}

function ensureEulaFile() {
  if (!fs.existsSync(EULA_FILE)) {
    fs.writeFileSync(
      EULA_FILE,
      "# Arquivo gerado automaticamente pelo host\n" + "eula=true\n",
      "utf8"
    );
    addConsoleLine("Arquivo eula.txt criado automaticamente com eula=true.");
  }
}

ensureServerPropertiesFile();
ensureEulaFile();

/* =========================
   TIKTOK LIVE AUTOMATIONS
========================= */

function ensureTikTokRulesFile() {
  if (!fs.existsSync(TIKTOK_RULES_FILE)) {
    fs.writeFileSync(
      TIKTOK_RULES_FILE,
      JSON.stringify({ rules: [] }, null, 2),
      "utf8"
    );
  }
}

function readTikTokRules() {
  ensureTikTokRulesFile();

  try {
    const raw = fs.readFileSync(TIKTOK_RULES_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (!parsed.rules || !Array.isArray(parsed.rules)) {
      return { rules: [] };
    }

    return parsed;
  } catch (err) {
    addConsoleLine("Erro ao ler tiktok-rules.json: " + err.message);
    return { rules: [] };
  }
}

function writeTikTokRules(data) {
  fs.writeFileSync(TIKTOK_RULES_FILE, JSON.stringify(data, null, 2), "utf8");
}

ensureTikTokRulesFile();

const tiktokCounters = {
  follow: 0,
  like: 0,
  gift: 0,
  share: 0,
  member: 0
};

function resetTikTokCounters() {
  tiktokCounters.follow = 0;
  tiktokCounters.like = 0;
  tiktokCounters.gift = 0;
  tiktokCounters.share = 0;
  tiktokCounters.member = 0;
}

function runMinecraftCommandFromTikTok(command, meta = {}) {
  if (!isServerRunning()) {
    addConsoleLine("TikTok automation ignorada: servidor Minecraft offline.");
    return;
  }

  if (!command || typeof command !== "string") {
    return;
  }

  const cleanCommand = command.trim();
  if (!cleanCommand) return;

  const finalCommand = cleanCommand.startsWith("/")
    ? cleanCommand.slice(1)
    : cleanCommand;

  try {
    mcProcess.stdin.write(finalCommand + "\n");
    addConsoleLine(
      `[TikTok Automation] Evento=${meta.eventType || "?"} Regra=${meta.ruleId || "?"} Comando=${finalCommand}`
    );
  } catch (err) {
    addConsoleLine("Erro ao executar automação TikTok: " + err.message);
  }
}

function processTikTokAutomation(eventType, amount = 1) {
  const db = readTikTokRules();
  const rules = db.rules || [];

  if (!Object.prototype.hasOwnProperty.call(tiktokCounters, eventType)) {
    return;
  }

  tiktokCounters[eventType] += Number(amount) || 1;

  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    if (rule.eventType !== eventType) continue;

    const everyCount = Math.max(1, Number(rule.everyCount) || 1);
    const counter = tiktokCounters[eventType];

    if (counter % everyCount === 0) {
      runMinecraftCommandFromTikTok(rule.command, {
        eventType,
        ruleId: rule.id
      });
    }
  }
}

/* =========================
   LOGIN / TOKENS
========================= */

const activeTokens = new Map();

function generateToken() {
  return crypto.randomBytes(24).toString("hex");
}

function getTokenFromRequest(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return null;
}

function requireAuth(req, res, next) {
  let token = getTokenFromRequest(req);

  if (!token && req.query && req.query.token) {
    token = String(req.query.token);
  }

  if (!token || !activeTokens.has(token)) {
    return res.status(401).json({ error: "Não autorizado." });
  }

  req.username = activeTokens.get(token);
  next();
}

/* =========================
   MINECRAFT PROCESS
========================= */

function isServerRunning() {
  return mcProcess !== null;
}

function getLocalIPv4() {
  const nets = os.networkInterfaces();

  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const familyV4Value = typeof net.family === "string" ? "IPv4" : 4;
      if (net.family === familyV4Value && !net.internal) {
        return net.address;
      }
    }
  }

  return "127.0.0.1";
}

function startMinecraftProcess() {
  if (!fs.existsSync(SERVER_JAR)) {
    throw new Error("server.jar não encontrado dentro de server-files.");
  }

  ensureEulaFile();
  ensureServerPropertiesFile();

  addConsoleLine("Iniciando servidor Minecraft...");

  mcProcess = spawn(
    JAVA_PATH,
    [`-Xms${JAVA_RAM_MIN}`, `-Xmx${JAVA_RAM_MAX}`, "-jar", "server.jar", "nogui"],
    {
      cwd: SERVER_DIR,
      shell: process.platform === "win32"
    }
  );

  mcProcess.stdout.on("data", (data) => {
    const text = data.toString();
    text.split(/\r?\n/).forEach((line) => {
      if (line.trim()) addConsoleLine(line);
    });
  });

  mcProcess.stderr.on("data", (data) => {
    const text = data.toString();
    text.split(/\r?\n/).forEach((line) => {
      if (line.trim()) addConsoleLine("[ERRO] " + line);
    });
  });

  mcProcess.on("close", (code) => {
    addConsoleLine(`Servidor fechado com código ${code}.`);
    mcProcess = null;
  });

  mcProcess.on("error", (err) => {
    addConsoleLine("Falha ao iniciar o Minecraft: " + err.message);
    mcProcess = null;
  });
}

/* =========================
   PATH SEGURO
========================= */

function normalizeRelativePath(relativePath = "") {
  return String(relativePath).replace(/\\/g, "/").replace(/^\/+/, "");
}

function safePath(relativePath = "") {
  const clean = normalizeRelativePath(relativePath);
  const resolved = path.resolve(SERVER_DIR, clean);
  const relative = path.relative(SERVER_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Caminho inválido.");
  }

  return resolved;
}

function listDirectory(relativePath = "") {
  const clean = normalizeRelativePath(relativePath);
  const fullPath = safePath(clean);

  if (!fs.existsSync(fullPath)) {
    throw new Error("Pasta não encontrada.");
  }

  const stat = fs.statSync(fullPath);
  if (!stat.isDirectory()) {
    throw new Error("O caminho informado não é uma pasta.");
  }

  const entries = fs.readdirSync(fullPath, { withFileTypes: true });

  return entries
    .map((entry) => {
      const entryRelativePath = clean
        ? `${clean}/${entry.name}`.replace(/\\/g, "/")
        : entry.name;

      return {
        name: entry.name,
        path: entryRelativePath,
        type: entry.isDirectory() ? "folder" : "file"
      };
    })
    .sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name, "pt-BR");
      return a.type === "folder" ? -1 : 1;
    });
}

/* =========================
   LOGIN API
========================= */

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = findUser(username);

  if (!user || user.password !== password) {
    return res.status(401).json({ error: "Usuário ou senha inválidos." });
  }

  const token = generateToken();
  activeTokens.set(token, user.username);

  res.json({
    ok: true,
    token,
    user: {
      username: user.username,
      avatarUrl: user.avatarUrl || ""
    }
  });
});

app.post("/api/google-login", async (req, res) => {
  try {
    const { credential } = req.body || {};

    if (!credential) {
      return res.status(400).json({ error: "Credential do Google não enviada." });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();

    if (!payload || !payload.email) {
      return res.status(400).json({ error: "Conta Google inválida." });
    }

    const email = String(payload.email).toLowerCase();

    const googleUsersMap = {
      "gabsgameplai@gmail.com": "adminSassdio"
    };

    const username = googleUsersMap[email] || payload.name || email;

    const token = generateToken();
    activeTokens.set(token, username);

    const existingUser = findUser(username);

    res.json({
      ok: true,
      token,
      user: {
        username,
        avatarUrl: existingUser?.avatarUrl || ""
      }
    });
  } catch (err) {
    addConsoleLine("Erro Google login: " + err.message);
    res.status(400).json({ error: "Falha ao validar login Google." });
  }
});

app.post("/api/logout", requireAuth, (req, res) => {
  const token = getTokenFromRequest(req);

  if (token) {
    activeTokens.delete(token);
  }

  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  const user = findUser(req.username);

  res.json({
    ok: true,
    user: {
      username: req.username,
      avatarUrl: user?.avatarUrl || ""
    }
  });
});

app.post("/api/change-password", requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Preencha a senha atual e a nova senha." });
  }

  if (String(newPassword).length < 4) {
    return res.status(400).json({ error: "A nova senha precisa ter pelo menos 4 caracteres." });
  }

  const db = readUsers();
  const user = db.users.find((u) => u.username === req.username);

  if (!user) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  if (user.password !== currentPassword) {
    return res.status(400).json({ error: "Senha atual incorreta." });
  }

  user.password = newPassword;
  writeUsers(db);

  res.json({ ok: true, message: "Senha alterada com sucesso." });
});

/* =========================
   AVATAR / CONTA
========================= */

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, AVATARS_DIR);
    },
    filename: function (req, file, cb) {
      const ext = path.extname(file.originalname || "").toLowerCase() || ".png";
      cb(null, `${req.username}-${Date.now()}${ext}`);
    }
  }),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: function (req, file, cb) {
    const allowed = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
    const ext = path.extname(file.originalname || "").toLowerCase();

    if (!allowed.includes(ext)) {
      return cb(new Error("Envie uma imagem PNG, JPG, JPEG, GIF ou WEBP."));
    }

    cb(null, true);
  }
});

app.post("/api/account/avatar", requireAuth, (req, res) => {
  avatarUpload.single("avatar")(req, res, function (err) {
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Nenhuma imagem enviada." });
    }

    const db = readUsers();
    const user = db.users.find((u) => u.username === req.username);

    if (!user) {
      return res.status(404).json({ error: "Usuário não encontrado." });
    }

    if (user.avatarUrl) {
      const oldPath = path.join(__dirname, user.avatarUrl.replace(/^\/+/, ""));
      try {
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      } catch (e) {}
    }

    user.avatarUrl = `/uploads/avatars/${req.file.filename}`;
    writeUsers(db);

    addConsoleLine(`Avatar atualizado por ${req.username}`);

    res.json({
      ok: true,
      message: "Imagem de perfil atualizada com sucesso.",
      avatarUrl: user.avatarUrl
    });
  });
});

/* =========================
   STATUS / CONSOLE / COMMANDS
========================= */

app.get("/api/ping", (req, res) => {
  res.json({
    ok: true,
    message: "Backend online",
    time: new Date().toISOString()
  });
});

app.get("/api/status", requireAuth, (req, res) => {
  const localIp = getLocalIPv4();
  const localBaseUrl = `http://${localIp}:${PORT}`;

  res.json({
    ok: true,
    online: isServerRunning(),
    pid: mcProcess ? mcProcess.pid : null,
    panelUrl: localBaseUrl,
    localPanelUrl: localBaseUrl,
    localIp,
    minecraftHost: localIp,
    minecraftPort: 25565
  });
});

app.get("/api/console", requireAuth, (req, res) => {
  res.json({
    lines: consoleBuffer
  });
});

app.get("/api/public-url", requireAuth, (req, res) => {
  const localIp = getLocalIPv4();
  const localBaseUrl = `http://${localIp}:${PORT}`;

  res.json({
    publicUrl: null,
    localUrl: localBaseUrl
  });
});

app.get("/api/server-config", requireAuth, (req, res) => {
  try {
    ensureServerPropertiesFile();

    const raw = fs.readFileSync(SERVER_PROPERTIES_FILE, "utf8");
    const props = parseProperties(raw);

    res.json({
      ok: true,
      config: props,
      raw
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/server-config", requireAuth, (req, res) => {
  try {
    ensureServerPropertiesFile();

    const { config } = req.body || {};

    if (!config || typeof config !== "object") {
      return res.status(400).json({ error: "Configuração inválida." });
    }

    const currentRaw = fs.readFileSync(SERVER_PROPERTIES_FILE, "utf8");
    const currentProps = parseProperties(currentRaw);

    const merged = {
      ...currentProps,
      ...config
    };

    const content = stringifyProperties(merged);
    fs.writeFileSync(SERVER_PROPERTIES_FILE, content, "utf8");

    addConsoleLine(`Configurações do servidor alteradas por ${req.username}`);

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/start", requireAuth, (req, res) => {
  try {
    if (isServerRunning()) {
      return res.status(400).json({ error: "Servidor já está rodando." });
    }

    startMinecraftProcess();
    res.json({ ok: true, message: "Servidor iniciando." });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/stop", requireAuth, (req, res) => {
  try {
    if (!isServerRunning()) {
      return res.status(400).json({ error: "Servidor não está rodando." });
    }

    mcProcess.stdin.write("stop\n");
    addConsoleLine("Comando stop enviado.");
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/restart", requireAuth, (req, res) => {
  try {
    if (!isServerRunning()) {
      return res.status(400).json({ error: "Servidor não está rodando." });
    }

    mcProcess.stdin.write("stop\n");
    addConsoleLine("Reinício solicitado.");

    const interval = setInterval(() => {
      if (!isServerRunning()) {
        clearInterval(interval);

        try {
          startMinecraftProcess();
        } catch (err) {
          addConsoleLine("Falha ao reiniciar: " + err.message);
        }
      }
    }, 1000);

    res.json({ ok: true, message: "Servidor reiniciando." });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/command", requireAuth, (req, res) => {
  try {
    const { command } = req.body || {};

    if (!isServerRunning()) {
      return res.status(400).json({ error: "Servidor não está rodando." });
    }

    if (!command || typeof command !== "string") {
      return res.status(400).json({ error: "Comando inválido." });
    }

    mcProcess.stdin.write(command + "\n");
    addConsoleLine("> " + command);

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* =========================
   UPLOAD DE PLUGIN
========================= */

const pluginUpload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, PLUGINS_DIR);
    },
    filename: function (req, file, cb) {
      cb(null, file.originalname);
    }
  }),
  fileFilter: function (req, file, cb) {
    if (!file.originalname.toLowerCase().endsWith(".jar")) {
      return cb(new Error("Só arquivos .jar são permitidos."));
    }
    cb(null, true);
  }
});

app.post("/api/upload-plugin", requireAuth, (req, res) => {
  pluginUpload.single("plugin")(req, res, function (err) {
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Nenhum plugin enviado." });
    }

    addConsoleLine(`Plugin enviado por ${req.username}: ${req.file.originalname}`);

    res.json({
      ok: true,
      filename: req.file.originalname
    });
  });
});

app.get("/api/plugins", requireAuth, (req, res) => {
  try {
    const files = fs
      .readdirSync(PLUGINS_DIR)
      .filter((name) => name.toLowerCase().endsWith(".jar"));

    res.json({ plugins: files });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* =========================
   FILE MANAGER
========================= */

app.get("/api/files", requireAuth, (req, res) => {
  try {
    const dir = req.query.dir || "";
    const items = listDirectory(dir);

    res.json({
      currentPath: normalizeRelativePath(dir),
      items
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/file", requireAuth, (req, res) => {
  try {
    const filePath = req.query.path;

    if (!filePath) {
      return res.status(400).json({ error: "Path obrigatório." });
    }

    const clean = normalizeRelativePath(filePath);
    const fullPath = safePath(clean);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: "Arquivo não encontrado." });
    }

    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) {
      return res.status(400).json({ error: "O caminho não é um arquivo." });
    }

    const content = fs.readFileSync(fullPath, "utf8");

    res.json({
      path: clean,
      name: path.basename(fullPath),
      content
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/file", requireAuth, (req, res) => {
  try {
    const { path: filePath, content } = req.body || {};

    if (!filePath) {
      return res.status(400).json({ error: "Path obrigatório." });
    }

    const clean = normalizeRelativePath(filePath);
    const fullPath = safePath(clean);
    const parentDir = path.dirname(fullPath);

    fs.mkdirSync(parentDir, { recursive: true });
    fs.writeFileSync(fullPath, content ?? "", "utf8");

    addConsoleLine(`Arquivo salvo por ${req.username}: ${clean}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/file/new", requireAuth, (req, res) => {
  try {
    const { dir = "", name = "" } = req.body || {};
    const cleanDir = normalizeRelativePath(dir);
    const cleanName = String(name).trim();

    if (!cleanName) {
      return res.status(400).json({ error: "Nome obrigatório." });
    }

    const relativePath = cleanDir ? `${cleanDir}/${cleanName}` : cleanName;
    const fullPath = safePath(relativePath);
    const parentDir = path.dirname(fullPath);

    if (fs.existsSync(fullPath)) {
      return res.status(400).json({ error: "Arquivo já existe." });
    }

    fs.mkdirSync(parentDir, { recursive: true });
    fs.writeFileSync(fullPath, "", "utf8");

    addConsoleLine(`Arquivo criado por ${req.username}: ${relativePath}`);
    res.json({ ok: true, path: relativePath });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/folder/new", requireAuth, (req, res) => {
  try {
    const { dir = "", name = "" } = req.body || {};
    const cleanDir = normalizeRelativePath(dir);
    const cleanName = String(name).trim();

    if (!cleanName) {
      return res.status(400).json({ error: "Nome obrigatório." });
    }

    const relativePath = cleanDir ? `${cleanDir}/${cleanName}` : cleanName;
    const fullPath = safePath(relativePath);

    if (fs.existsSync(fullPath)) {
      return res.status(400).json({ error: "Pasta já existe." });
    }

    fs.mkdirSync(fullPath, { recursive: true });

    addConsoleLine(`Pasta criada por ${req.username}: ${relativePath}`);
    res.json({ ok: true, path: relativePath });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/file", requireAuth, (req, res) => {
  try {
    const filePath = req.query.path;

    if (!filePath) {
      return res.status(400).json({ error: "Path obrigatório." });
    }

    const clean = normalizeRelativePath(filePath);
    const fullPath = safePath(clean);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: "Arquivo ou pasta não encontrado." });
    }

    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      addConsoleLine(`Pasta removida por ${req.username}: ${clean}`);
    } else {
      fs.unlinkSync(fullPath);
      addConsoleLine(`Arquivo removido por ${req.username}: ${clean}`);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/file/rename", requireAuth, (req, res) => {
  try {
    const { oldPath, newName } = req.body || {};
    const cleanOldPath = normalizeRelativePath(oldPath);
    const cleanNewName = String(newName || "").trim();

    if (!cleanOldPath || !cleanNewName) {
      return res.status(400).json({ error: "Dados inválidos." });
    }

    const oldFullPath = safePath(cleanOldPath);

    if (!fs.existsSync(oldFullPath)) {
      return res.status(404).json({ error: "Arquivo não encontrado." });
    }

    const parentDir = path.posix.dirname(cleanOldPath);
    const newRelativePath =
      parentDir && parentDir !== "."
        ? `${parentDir}/${cleanNewName}`
        : cleanNewName;

    const newFullPath = safePath(newRelativePath);

    if (fs.existsSync(newFullPath)) {
      return res.status(400).json({ error: "Já existe um item com esse nome." });
    }

    fs.renameSync(oldFullPath, newFullPath);

    addConsoleLine(`Item renomeado por ${req.username}: ${cleanOldPath} -> ${newRelativePath}`);

    res.json({
      ok: true,
      newPath: newRelativePath
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* =========================
   TIKTOK LIVE
========================= */

let tiktokConnection = null;
let tiktokState = {
  connected: false,
  uniqueId: "",
  roomId: null,
  startedAt: null,
  lastError: null
};

const tiktokClients = new Set();
const tiktokEventBuffer = [];

function addTikTokEvent(type, data = {}) {
  const payload = {
    id: crypto.randomBytes(8).toString("hex"),
    type,
    time: new Date().toISOString(),
    data
  };

  tiktokEventBuffer.push(payload);

  if (tiktokEventBuffer.length > 300) {
    tiktokEventBuffer.shift();
  }

  const serialized = `data: ${JSON.stringify(payload)}\n\n`;

  for (const client of tiktokClients) {
    try {
      client.write(serialized);
    } catch (err) {}
  }

  return payload;
}

function normalizeTikTokUniqueId(value = "") {
  return String(value).trim().replace(/^@+/, "");
}

async function disconnectTikTokLiveInternal() {
  try {
    if (tiktokConnection) {
      try {
        await tiktokConnection.disconnect();
      } catch (err) {
        addConsoleLine("Erro ao desconectar TikTok LIVE: " + err.message);
      }
    }
  } finally {
    tiktokConnection = null;
    tiktokState.connected = false;
    tiktokState.roomId = null;
    tiktokState.startedAt = null;
  }
}

async function connectTikTokLiveInternal(uniqueId) {
  const cleanUniqueId = normalizeTikTokUniqueId(uniqueId);

  if (!cleanUniqueId) {
    throw new Error("Informe o @ do TikTok.");
  }

  if (tiktokConnection) {
    await disconnectTikTokLiveInternal();
  }

  tiktokState.uniqueId = cleanUniqueId;
  tiktokState.lastError = null;

  const connection = new WebcastPushConnection(cleanUniqueId, {
    enableExtendedGiftInfo: true
  });

  connection.on("chat", (event) => {
    addTikTokEvent("chat", {
      userId: event.userId || null,
      nickname: event.nickname || "Desconhecido",
      uniqueId: event.uniqueId || "",
      comment: event.comment || ""
    });
  });

  connection.on("gift", (event) => {
    addTikTokEvent("gift", {
      userId: event.userId || null,
      nickname: event.nickname || "Desconhecido",
      uniqueId: event.uniqueId || "",
      giftId: event.giftId || null,
      giftName: event.giftName || "Presente",
      repeatCount: event.repeatCount || 1,
      diamondCount: event.diamondCount || 0
    });

    processTikTokAutomation("gift", event.repeatCount || 1);
  });

  connection.on("like", (event) => {
    addTikTokEvent("like", {
      userId: event.userId || null,
      nickname: event.nickname || "Desconhecido",
      uniqueId: event.uniqueId || "",
      likeCount: event.likeCount || 0,
      totalLikeCount: event.totalLikeCount || 0
    });

    processTikTokAutomation("like", event.likeCount || 1);
  });

  connection.on("follow", (event) => {
    addTikTokEvent("follow", {
      userId: event.userId || null,
      nickname: event.nickname || "Desconhecido",
      uniqueId: event.uniqueId || ""
    });

    processTikTokAutomation("follow", 1);
  });

  connection.on("share", (event) => {
    addTikTokEvent("share", {
      userId: event.userId || null,
      nickname: event.nickname || "Desconhecido",
      uniqueId: event.uniqueId || ""
    });

    processTikTokAutomation("share", 1);
  });

  connection.on("member", (event) => {
    addTikTokEvent("member", {
      userId: event.userId || null,
      nickname: event.nickname || "Desconhecido",
      uniqueId: event.uniqueId || ""
    });

    processTikTokAutomation("member", 1);
  });

  connection.on("roomUser", (event) => {
    addTikTokEvent("roomUser", {
      viewerCount: event.viewerCount || 0
    });
  });

  connection.on("streamEnd", () => {
    addConsoleLine(`TikTok LIVE encerrada: @${tiktokState.uniqueId}`);
    addTikTokEvent("streamEnd", {
      uniqueId: tiktokState.uniqueId
    });

    tiktokState.connected = false;
    tiktokState.roomId = null;
    tiktokState.startedAt = null;
  });

  connection.on("disconnected", () => {
    addConsoleLine(`TikTok LIVE desconectada: @${tiktokState.uniqueId}`);
    addTikTokEvent("disconnected", {
      uniqueId: tiktokState.uniqueId
    });

    tiktokState.connected = false;
    tiktokState.roomId = null;
    tiktokState.startedAt = null;
  });

  connection.on("error", (err) => {
    const message = err?.message || "Erro desconhecido no TikTok LIVE";
    tiktokState.lastError = message;
    addConsoleLine("Erro TikTok LIVE: " + message);
    addTikTokEvent("error", {
      uniqueId: tiktokState.uniqueId,
      message
    });
  });

  const state = await connection.connect();

  tiktokConnection = connection;
  tiktokState.connected = true;
  tiktokState.roomId = state?.roomId || null;
  tiktokState.startedAt = new Date().toISOString();
  tiktokState.lastError = null;

  resetTikTokCounters();

  addConsoleLine(`TikTok LIVE conectada com @${cleanUniqueId}`);
  addTikTokEvent("connected", {
    uniqueId: cleanUniqueId,
    roomId: tiktokState.roomId
  });

  return {
    uniqueId: cleanUniqueId,
    roomId: tiktokState.roomId
  };
}

app.get("/api/tiktoklive/status", requireAuth, (req, res) => {
  res.json({
    ok: true,
    state: {
      ...tiktokState
    },
    recentEvents: tiktokEventBuffer.slice(-50)
  });
});

app.post("/api/tiktoklive/connect", requireAuth, async (req, res) => {
  try {
    const { uniqueId } = req.body || {};
    const result = await connectTikTokLiveInternal(uniqueId);

    res.json({
      ok: true,
      message: `Conectado ao TikTok LIVE de @${result.uniqueId}`,
      state: {
        ...tiktokState
      }
    });
  } catch (err) {
    tiktokState.connected = false;
    tiktokState.lastError = err.message;
    res.status(400).json({
      error: err.message || "Falha ao conectar no TikTok LIVE."
    });
  }
});

app.post("/api/tiktoklive/disconnect", requireAuth, async (req, res) => {
  try {
    const lastUniqueId = tiktokState.uniqueId;
    await disconnectTikTokLiveInternal();

    addTikTokEvent("manualDisconnect", {
      uniqueId: lastUniqueId || ""
    });

    res.json({
      ok: true,
      message: "TikTok LIVE desconectado."
    });
  } catch (err) {
    res.status(400).json({
      error: err.message || "Falha ao desconectar TikTok LIVE."
    });
  }
});

app.get("/api/tiktoklive/stream", requireAuth, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  res.write(`data: ${JSON.stringify({
    id: crypto.randomBytes(8).toString("hex"),
    type: "hello",
    time: new Date().toISOString(),
    data: {
      connected: tiktokState.connected,
      uniqueId: tiktokState.uniqueId
    }
  })}\n\n`);

  for (const event of tiktokEventBuffer.slice(-20)) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  tiktokClients.add(res);

  req.on("close", () => {
    tiktokClients.delete(res);
  });
});

/* =========================
   TIKTOK LIVE RULES API
========================= */

app.get("/api/tiktoklive/rules", requireAuth, (req, res) => {
  const db = readTikTokRules();

  res.json({
    ok: true,
    rules: db.rules || [],
    counters: tiktokCounters
  });
});

app.post("/api/tiktoklive/rules", requireAuth, (req, res) => {
  try {
    const { eventType, everyCount, command, enabled = true } = req.body || {};

    const allowedEvents = ["follow", "like", "gift", "share", "member"];

    if (!allowedEvents.includes(eventType)) {
      return res.status(400).json({ error: "Tipo de evento inválido." });
    }

    if (!command || typeof command !== "string") {
      return res.status(400).json({ error: "Comando inválido." });
    }

    const count = Math.max(1, Number(everyCount) || 1);

    const db = readTikTokRules();
    const rule = {
      id: crypto.randomBytes(8).toString("hex"),
      eventType,
      everyCount: count,
      command: String(command).trim(),
      enabled: Boolean(enabled)
    };

    db.rules.push(rule);
    writeTikTokRules(db);

    addConsoleLine(`Regra TikTok criada por ${req.username}: ${eventType} / ${count} / ${command}`);

    res.json({
      ok: true,
      message: "Regra criada com sucesso.",
      rule
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/tiktoklive/rules/:id", requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { eventType, everyCount, command, enabled } = req.body || {};

    const allowedEvents = ["follow", "like", "gift", "share", "member"];

    const db = readTikTokRules();
    const rule = db.rules.find((r) => r.id === id);

    if (!rule) {
      return res.status(404).json({ error: "Regra não encontrada." });
    }

    if (eventType !== undefined) {
      if (!allowedEvents.includes(eventType)) {
        return res.status(400).json({ error: "Tipo de evento inválido." });
      }
      rule.eventType = eventType;
    }

    if (everyCount !== undefined) {
      rule.everyCount = Math.max(1, Number(everyCount) || 1);
    }

    if (command !== undefined) {
      if (!String(command).trim()) {
        return res.status(400).json({ error: "Comando inválido." });
      }
      rule.command = String(command).trim();
    }

    if (enabled !== undefined) {
      rule.enabled = Boolean(enabled);
    }

    writeTikTokRules(db);

    addConsoleLine(`Regra TikTok editada por ${req.username}: ${id}`);

    res.json({
      ok: true,
      message: "Regra atualizada com sucesso.",
      rule
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/tiktoklive/rules/:id", requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const db = readTikTokRules();

    const before = db.rules.length;
    db.rules = db.rules.filter((r) => r.id !== id);

    if (db.rules.length === before) {
      return res.status(404).json({ error: "Regra não encontrada." });
    }

    writeTikTokRules(db);

    addConsoleLine(`Regra TikTok removida por ${req.username}: ${id}`);

    res.json({
      ok: true,
      message: "Regra removida com sucesso."
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/tiktoklive/rules/reset-counters", requireAuth, (req, res) => {
  resetTikTokCounters();

  res.json({
    ok: true,
    message: "Contadores resetados com sucesso.",
    counters: tiktokCounters
  });
});

/* =========================
   ERROS
========================= */

app.use((req, res) => {
  res.status(404).json({ error: "Rota não encontrada." });
});

app.use((err, req, res, next) => {
  addConsoleLine("Erro interno: " + err.message);
  res.status(500).json({ error: "Erro interno do servidor." });
});

process.on("unhandledRejection", (reason) => {
  addConsoleLine("UnhandledRejection: " + String(reason));
});

process.on("uncaughtException", (err) => {
  addConsoleLine("UncaughtException: " + err.message);
});

/* =========================
   START
========================= */

app.listen(PORT, HOST, () => {
  const localIp = getLocalIPv4();
  addConsoleLine(`Backend iniciado em http://localhost:${PORT}`);
  addConsoleLine(`Backend na rede local: http://${localIp}:${PORT}`);
  addConsoleLine("Painel do host Minecraft pronto.");
});