// Minimal Express server that serves the static site in public/.
const path = require("path");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");

app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/details", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "details.html"));
});

app.get("/contact", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "contact.html"));
});

app.listen(PORT, () => {
  console.log(`ns-vse-webdev listening on port ${PORT}`);
});
