const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const dotenv = require("dotenv");

dotenv.config();

const authRoutes = require("./routes/auth.js");
const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(cors({
  origin: process.env.CLIENT_URL || process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true,
}));

app.use("/api/auth", authRoutes);

const frontendDistPath = path.join(__dirname, "../frontend/dist");
const frontendRootPath = path.join(__dirname, "../frontend");
const frontendStaticPath = fs.existsSync(frontendDistPath) ? frontendDistPath : frontendRootPath;

app.use(express.static(frontendStaticPath));
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return next();
  }

  return res.sendFile(path.join(frontendStaticPath, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started running on port ${PORT}`);
});