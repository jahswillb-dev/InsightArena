const raw = process.env.NEXT_PUBLIC_API_URL;

if (!raw) {
  const msg =
    "Set NEXT_PUBLIC_API_URL in frontend/.env.local — see .env.example";
  if (process.env.NODE_ENV === "development") {
    throw new Error(msg);
  } else {
    console.error(`[env] ${msg}`);
  }
}

export const env = {
  API_URL: (raw ?? "").replace(/\/+$/, ""),
};
