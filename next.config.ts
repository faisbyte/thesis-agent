import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native modules (SQLite, ONNX runtime for the local embedding model); keep them out of the server bundle.
  serverExternalPackages: ["better-sqlite3", "@huggingface/transformers", "onnxruntime-node"],
};

export default nextConfig;
