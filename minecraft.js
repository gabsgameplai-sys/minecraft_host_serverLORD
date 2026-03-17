const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const {
  SERVER_DIR,
  SERVER_JAR_NAME,
  JAVA_RAM_MIN,
  JAVA_RAM_MAX,
  JAVA_PATH
} = require("./config");

let mcProcess = null;
let consoleLines = [];

const MAX_CONSOLE_LINES = 500;

function addConsoleLine(line) {
  consoleLines.push(line);

  if (consoleLines.length > MAX_CONSOLE_LINES) {
    consoleLines = consoleLines.slice(-MAX_CONSOLE_LINES);
  }

  console.log(line);
}

function isRunning() {
  return mcProcess !== null;
}

function startServer() {

  if (isRunning()) {
    return { ok: false, error: "Servidor já está rodando." };
  }

  const jarPath = path.join(SERVER_DIR, SERVER_JAR_NAME);

  if (!fs.existsSync(jarPath)) {
    return {
      ok: false,
      error: `Arquivo não encontrado: ${SERVER_JAR_NAME}`
    };
  }

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

    text.split(/\r?\n/).forEach(line => {
      if (line.trim()) addConsoleLine(line);
    });
  });

  mcProcess.stderr.on("data", (data) => {
    const text = data.toString();

    text.split(/\r?\n/).forEach(line => {
      if (line.trim()) addConsoleLine("[ERRO] " + line);
    });
  });

  mcProcess.on("close", (code) => {
    addConsoleLine("Servidor parado. Código: " + code);
    mcProcess = null;
  });

  return { ok: true };
}

function stopServer() {

  if (!isRunning()) {
    return { ok: false, error: "Servidor não está rodando." };
  }

  mcProcess.stdin.write("stop\n");

  return { ok: true };
}

function restartServer() {

  if (!isRunning()) {
    return startServer();
  }

  mcProcess.stdin.write("stop\n");

  setTimeout(() => {
    startServer();
  }, 5000);

  return { ok: true };
}

function sendCommand(command) {

  if (!isRunning()) {
    return { ok: false, error: "Servidor offline." };
  }

  mcProcess.stdin.write(command + "\n");

  return { ok: true };
}

function getConsole() {
  return consoleLines.slice(-200);
}

module.exports = {
  startServer,
  stopServer,
  restartServer,
  sendCommand,
  getConsole,
  isRunning
};
