import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import reactLogo from "@/features/built-with/assets/react.svg";
import shadcnLogo from "@/features/built-with/assets/shadcn.svg";
import tauriLogo from "@/features/built-with/assets/tauri.svg";
import viteLogo from "@/features/built-with/assets/vite.svg";

export default function BuiltWith() {
  return (
    <div className="flex flex-row justify-center">
      <LogoLink alt="Vite" href="https://vitejs.dev" src={viteLogo} />
      <LogoLink alt="Tauri" href="https://tauri.app" src={tauriLogo} />
      <LogoLink alt="React" href="https://reactjs.org" src={reactLogo} />
      <LogoLink alt="shadcn/ui" href="https://ui.shadcn.com" src={shadcnLogo} />
    </div>
  );
}

function LogoLink({
  href,
  src,
  alt,
}: {
  href: string;
  src: string;
  alt: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a className="mx-2" href={href} rel="noreferrer" target="_blank">
          <img
            alt={alt}
            className="h-10 w-10 transition-all duration-300 hover:scale-125"
            height={40}
            src={src}
            width={40}
          />
        </a>
      </TooltipTrigger>
      <TooltipContent>
        <p>{alt}</p>
      </TooltipContent>
    </Tooltip>
  );
}
