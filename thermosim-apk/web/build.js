const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

async function build() {
  // Bundle JSX → single JS
  const result = await esbuild.build({
    entryPoints: ["index.jsx"],
    bundle: true,
    minify: true,
    format: "iife",
    target: ["es2020"],
    write: false,
    jsx: "automatic",
    loader: { ".jsx": "jsx" },
  });

  const jsCode = result.outputFiles[0].text;

  const html = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>ThermoSim v15</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#08080e;overflow-x:hidden;-webkit-tap-highlight-color:transparent;touch-action:manipulation;}
input[type=range]{-webkit-appearance:auto;appearance:auto;}
::-webkit-scrollbar{width:4px;}
::-webkit-scrollbar-track{background:#0a0a12;}
::-webkit-scrollbar-thumb{background:#2a2a3a;border-radius:2px;}
</style>
</head>
<body>
<div id="root"></div>
<script>${jsCode}</script>
</body>
</html>`;

  const outDir = path.join(__dirname, "..", "app", "src", "main", "assets");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "index.html"), html);
  console.log("✓ Built index.html →", path.join(outDir, "index.html"));
  console.log("  JS bundle size:", (jsCode.length / 1024).toFixed(1), "KB");
}

build().catch((e) => { console.error(e); process.exit(1); });
