// Generate app icons from a single padded master PNG.
// Usage: node tools/generate-icons.mjs
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SRC = path.resolve("web/_source/logo-shield@512.png");
const OUT = path.resolve("web");

const targets = [
    { name: "logo-shield.png", size: 256 }, // header logo (we'll display at 24/22px)
    { name: "favicon-32.png", size: 32 },
    { name: "favicon-16.png", size: 16 },
    { name: "apple-touch-icon.png", size: 180 }
];

async function run() {
    try {
        await fs.access(SRC);
    } catch {
        console.error(`❌ Master icon not found: ${SRC}`);
        process.exit(1);
    }

    await fs.mkdir(OUT, { recursive: true });

    for (const t of targets) {
        const outPath = path.join(OUT, t.name);
        await sharp(SRC)
            .resize(t.size, t.size, { fit: "cover" })
            .png({ compressionLevel: 9, adaptiveFiltering: true })
            .toFile(outPath);
        console.log(`✅ ${t.name} (${t.size}x${t.size})`);
    }

    // Optional: lightweight SVG favicon wrapper for crisp rendering in some browsers
    const svg = String.raw`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <image href="logo-shield.png" width="256" height="256" />
</svg>`;
    await fs.writeFile(path.join(OUT, "favicon.svg"), svg, "utf8");

    // Minimal webmanifest
    const manifest = {
        name: "Privacy Links Hoster",
        short_name: "PLH",
        icons: [
            { src: "/favicon-16.png", sizes: "16x16", type: "image/png" },
            { src: "/favicon-32.png", sizes: "32x32", type: "image/png" },
            { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }
        ],
        theme_color: "#0b1020",
        background_color: "#0b1020",
        display: "standalone"
    };
    await fs.writeFile(path.join(OUT, "site.webmanifest"), JSON.stringify(manifest, null, 2), "utf8");
    console.log("✅ site.webmanifest");
}

run().catch(err => { console.error(err); process.exit(1); });
