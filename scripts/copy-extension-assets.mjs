import { mkdir, copyFile, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const extensionLibDir = path.join(repoRoot, "extension", "lib");

const ASSETS = [
  // Tesseract.js runtime
  {
    from: ["node_modules", "tesseract.js", "dist", "tesseract.min.js"],
    to: ["extension", "lib", "tesseract.min.js"],
  },
  {
    from: ["node_modules", "tesseract.js", "dist", "tesseract.esm.min.js"],
    to: ["extension", "lib", "tesseract.esm.min.js"],
  },
  {
    from: ["node_modules", "tesseract.js", "dist", "worker.min.js"],
    to: ["extension", "lib", "worker.min.js"],
  },
  {
    from: ["node_modules", "tesseract.js-core", "tesseract-core.wasm.js"],
    to: ["extension", "lib", "tesseract-core.wasm.js"],
  },
  {
    from: ["node_modules", "tesseract.js-core", "tesseract-core.wasm"],
    to: ["extension", "lib", "tesseract-core.wasm"],
  },

  // Transformers.js runtime + ONNX Runtime Web wasm backends
  {
    from: [
      "node_modules",
      "@xenova",
      "transformers",
      "dist",
      "transformers.min.js",
    ],
    to: ["extension", "lib", "transformers.min.js"],
  },
  {
    from: ["node_modules", "@xenova", "transformers", "dist", "ort-wasm.wasm"],
    to: ["extension", "lib", "ort-wasm.wasm"],
  },
  {
    from: [
      "node_modules",
      "@xenova",
      "transformers",
      "dist",
      "ort-wasm-simd.wasm",
    ],
    to: ["extension", "lib", "ort-wasm-simd.wasm"],
  },
  {
    from: [
      "node_modules",
      "@xenova",
      "transformers",
      "dist",
      "ort-wasm-threaded.wasm",
    ],
    to: ["extension", "lib", "ort-wasm-threaded.wasm"],
  },
  {
    from: [
      "node_modules",
      "@xenova",
      "transformers",
      "dist",
      "ort-wasm-simd-threaded.wasm",
    ],
    to: ["extension", "lib", "ort-wasm-simd-threaded.wasm"],
  },
];

function resolveFrom(parts) {
  return path.join(repoRoot, ...parts);
}

async function ensureReadable(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(extensionLibDir, { recursive: true });

  const missing = [];

  for (const asset of ASSETS) {
    const src = resolveFrom(asset.from);
    const dst = resolveFrom(asset.to);

    if (!(await ensureReadable(src))) {
      missing.push(src);
      continue;
    }

    await mkdir(path.dirname(dst), { recursive: true });
    await copyFile(src, dst);
    // eslint-disable-next-line no-console
    console.log(
      `Copied: ${path.relative(repoRoot, src)} -> ${path.relative(
        repoRoot,
        dst
      )}`
    );
  }

  if (missing.length) {
    // eslint-disable-next-line no-console
    console.error("\nMissing required postinstall assets:");
    for (const filePath of missing) {
      // eslint-disable-next-line no-console
      console.error(`- ${path.relative(repoRoot, filePath)}`);
    }
    // eslint-disable-next-line no-console
    console.error("\nRun `npm install` (or reinstall deps) and re-try.");
    process.exitCode = 1;
  }
}

await main();
