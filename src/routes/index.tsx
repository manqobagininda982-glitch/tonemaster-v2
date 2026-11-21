import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [
    { title: "ToneMaster V2 by MG:SOUNDS" },
    { name: "description", content: "Play sampled instruments, install offline beat packs, record layered performances and export MP3 with ToneMaster V2." },
    { property: "og:title", content: "ToneMaster V2 by MG:SOUNDS" },
    { property: "og:description", content: "Your tones, beats and layered recording studio, together in ToneMaster." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary_large_image" },
  ] }),
  component: Index,
});

function Index() {
  return <iframe title="ToneMaster V2" src="/tonemaster/index.html" className="tonemaster-frame" allow="autoplay; midi; fullscreen" />;
}
