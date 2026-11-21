// Product configuration. ONLY the PUBLIC verification key belongs here. Never put the private key in this project.
export const CONFIG = {
  PRODUCT: 'ToneMaster', BRAND: 'MG:SOUNDS', PRICE: 'R250',
  // Ed25519 public key (base64url, 32 bytes). Generate your own pair with:  node tools/generate-keys.js
  PUBLIC_KEY: 'IgvI_dTUKL7LnEUAjF_TXATGC9PYxdJHDoB6sCeivHc',
  // How customers reach you to buy / request a licence. Edit before publishing (empty values are hidden in the UI).
  CONTACT: { email: '', whatsapp: '' },
  // Licence IDs you have chosen to revoke. Takes effect when users install an updated build (offline limitation – see README).
  REVOKED_LICENCE_IDS: [],
  // Tone store (online). The app only goes online when the user taps "Download tones" – everything else works offline.
  // The key below is the PUBLIC (publishable) key: it can only read published packs.
  VERSION: '2.0.0', VERSION_CODE: 2,
  API_ORIGIN: 'https://project--cf2e1702-2df4-4ce3-94bc-7e9ec1333e5e.lovable.app',
};
