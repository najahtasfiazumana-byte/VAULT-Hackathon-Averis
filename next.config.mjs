/** @type {import('next').NextConfig} */
const nextConfig = {
  // Ship the sample inbox + attachments + precomputed report with the serverless functions
  outputFileTracingIncludes: {
    "/**": ["./data/**/*"],
  },
  serverExternalPackages: ["mammoth", "xlsx"],
};
export default nextConfig;
