require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { OAuth2Client } = require("google-auth-library");

const app = express();

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const JAVA_RAM_MIN = process.env.JAVA_RAM_MIN || "1G";
const JAVA_RAM_MAX = process.env.JAVA_RAM_MAX || "2G";
const JAVA_PATH = process.env.JAVA_PATH || "java";

const SERVER_DIR = path.join(__dirname, "server-files");
const SERVER_JAR = process.env.SERVER_JAR || "server.jar";
const SERVER_PROPERTIES = path.join(SERVER_DIR, "server.properties");

let mcProcess = null;
let consoleLog = [];

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

if (!fs.existsSync(SERVER_DIR)) {
    fs.mkdirSync(SERVER_DIR);
}

function parseProperties(data) {
    const result = {};
    const lines = data.split("\n");

    for (let line of lines) {
        if (!line || line.startsWith("#")) continue;

        const i = line.indexOf("=");
        if (i === -1) continue;

        const key = line.substring(0, i).trim();
        const value = line.substring(i + 1).trim();

        result[key] = value;
    }

    return result;
}

function buildProperties(obj) {
    let out = "";

    for (const key in obj) {
        out += `${key}=${obj[key]}\n`;
    }

    return out;
}

function ensureServerProperties() {
    if (!fs.existsSync(SERVER_PROPERTIES)) {

        const defaultProps = {
            "motd": "Minecraft Server",
            "server-port": 25565,
            "max-players": 20,
            "online-mode": true,
            "difficulty": "easy",
            "gamemode": "survival",
            "pvp": true
        };

        fs.writeFileSync(SERVER_PROPERTIES, buildProperties(defaultProps));
    }
}

function startServer() {

    if (mcProcess) return;

    const jarPath = path.join(SERVER_DIR, SERVER_JAR);

    mcProcess = spawn(
        JAVA_PATH,
        [
            `-Xms${JAVA_RAM_MIN}`,
            `-Xmx${JAVA_RAM_MAX}`,
            "-jar",
            jarPath,
            "nogui"
        ],
        {
            cwd: SERVER_DIR
        }
    );

    mcProcess.stdout.on("data", data => {
        const msg = data.toString();
        consoleLog.push(msg);
        console.log(msg);
    });

    mcProcess.stderr.on("data", data => {
        const msg = data.toString();
        consoleLog.push(msg);
        console.log(msg);
    });

    mcProcess.on("close", () => {
        mcProcess = null;
    });
}

function stopServer() {

    if (!mcProcess) return;

    mcProcess.stdin.write("stop\n");
}

function restartServer() {

    stopServer();

    setTimeout(() => {
        startServer();
    }, 5000);
}

function getLocalIP() {

    const nets = os.networkInterfaces();

    for (const name of Object.keys(nets)) {

        for (const net of nets[name]) {

            if (net.family === "IPv4" && !net.internal) {
                return net.address;
            }

        }

    }

    return "localhost";
}

app.post("/api/login", async (req, res) => {

    try {

        const { token } = req.body;

        const ticket = await googleClient.verifyIdToken({
            idToken: token,
            audience: GOOGLE_CLIENT_ID
        });

        const payload = ticket.getPayload();

        res.json({
            ok: true,
            user: {
                name: payload.name,
                email: payload.email,
                picture: payload.picture
            }
        });

    } catch (e) {

        res.status(401).json({ ok: false });

    }

});

app.get("/api/status", (req, res) => {

    ensureServerProperties();

    const props = parseProperties(
        fs.readFileSync(SERVER_PROPERTIES, "utf8")
    );

    res.json({
        ok: true,
        online: mcProcess !== null,
        minecraftHost: getLocalIP(),
        minecraftPort: Number(props["server-port"] || 25565),
        pid: mcProcess ? mcProcess.pid : null
    });

});

app.post("/api/start", (req, res) => {

    startServer();

    res.json({ ok: true });

});

app.post("/api/stop", (req, res) => {

    stopServer();

    res.json({ ok: true });

});

app.post("/api/restart", (req, res) => {

    restartServer();

    res.json({ ok: true });

});

app.get("/api/console", (req, res) => {

    res.json({
        ok: true,
        log: consoleLog.slice(-200)
    });

});

app.post("/api/command", (req, res) => {

    if (!mcProcess) {
        return res.json({ ok: false });
    }

    const { command } = req.body;

    mcProcess.stdin.write(command + "\n");

    res.json({ ok: true });

});

app.get("/api/server-config", (req, res) => {

    ensureServerProperties();

    const raw = fs.readFileSync(SERVER_PROPERTIES, "utf8");

    const config = parseProperties(raw);

    res.json({
        ok: true,
        config,
        raw
    });

});

app.post("/api/server-config", (req, res) => {

    const config = req.body;

    fs.writeFileSync(
        SERVER_PROPERTIES,
        buildProperties(config)
    );

    res.json({ ok: true });

});

app.listen(PORT, HOST, () => {

    console.log("Painel rodando");

    console.log(`http://localhost:${PORT}`);

});
