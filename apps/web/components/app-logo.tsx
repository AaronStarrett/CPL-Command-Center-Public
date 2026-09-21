import Image from "next/image";

export function AppLogo({ priority = false }: { priority?: boolean }) {
  return (
    <Image
      src="/brand/cpl-logo.png"
      alt="Cyber Pirate Labs"
      width={1254}
      height={1254}
      priority={priority}
      unoptimized
    />
  );
}
