require("dotenv").config();
const path = require("path");

const ROOT_DIR = __dirname;

module.exports = {
  PORT: Number(process.env.PORT || 3000),
  HOST: "0.0.0.0",

  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || "",

  JAVA_RAM_MIN: process.env.JAVA_RAM_MIN || "1G",
  JAVA_RAM_MAX: process.env.JAVA_RAM_MAX || "2G",
  JAVA_PATH: process.env.JAVA_PATH || "java",

  SERVER_DIR: path.resolve(ROOT_DIR, process.env.SERVER_DIR || "server-files"),
  SERVER_JAR_NAME: process.env.SERVER_JAR || "server.jar",

  MAX_CONSOLE_LINES: 500
};
