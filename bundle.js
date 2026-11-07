const fs = require("fs");

const files = {
  "/index.html": { content: fs.readFileSync("public/index.html", "utf8"), type: "text/html; charset=utf-8" },
  "/admin.html": { content: fs.readFileSync("public/admin.html", "utf8"), type: "text/html; charset=utf-8" },
  "/css/style.css": { content: fs.readFileSync("public/css/style.css", "utf8"), type: "text/css; charset=utf-8" },
  "/js/chat.js": { content: fs.readFileSync("public/js/chat.js", "utf8"), type: "application/javascript; charset=utf-8" },
  "/js/admin.js": { content: fs.readFileSync("public/js/admin.js", "utf8"), type: "application/javascript; charset=utf-8" },
  "/robots.txt": { content: fs.readFileSync("public/robots.txt", "utf8"), type: "text/plain; charset=utf-8" }
};

const workerSrc = fs.readFileSync("src/worker.js", "utf8");
const staticBlock = `\nconst STATIC_FILES = ${JSON.stringify(files)};\n`;

const updatedWorker = workerSrc
  .replace(
    'export default {',
    `${staticBlock}\nexport default {`
  )
  .replace(
    `    // Slēptais Admin panelis
    if (path === "/admin" || path === "/admin/") {
      return env.ASSETS.fetch(new Request(new URL("/admin.html", request.url), request));
    }

    // Tiešā istabas saite saņēmējam (/room/:roomId)
    if (path.startsWith("/room/")) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
    }

    // Visi pārējie statiskie faili (index.html, css, js, robots.txt)
    return env.ASSETS.fetch(request);`,
    `    let assetKey = path;
    if (path === "/" || path === "/index.html" || path.startsWith("/room/")) {
      assetKey = "/index.html";
    } else if (path === "/admin" || path === "/admin/" || path === "/admin.html") {
      assetKey = "/admin.html";
    }

    if (STATIC_FILES[assetKey]) {
      return new Response(STATIC_FILES[assetKey].content, {
        status: 200,
        headers: {
          "Content-Type": STATIC_FILES[assetKey].type,
          "X-Robots-Tag": "noindex, nofollow, noarchive"
        }
      });
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not Found", { status: 404 });`
  );

fs.writeFileSync("src/worker-bundled.js", updatedWorker, "utf8");
console.log("Bundled worker size:", updatedWorker.length, "bytes");
