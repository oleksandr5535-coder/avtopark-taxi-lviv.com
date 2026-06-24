export default function handler(req, res) {
  const boltKeys = Object.keys(process.env).filter(k => k.toUpperCase().includes("BOLT"));
  res.status(200).json({
    boltVarsSeen: boltKeys,
    hasID: !!process.env.BOLT_CLIENT_ID,
    hasSECRET: !!process.env.BOLT_CLIENT_SECRET,
    idLen: (process.env.BOLT_CLIENT_ID || "").length,
    secretLen: (process.env.BOLT_CLIENT_SECRET || "").length,
  });
}
