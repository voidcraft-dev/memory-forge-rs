import { Star } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function GithubStarButton() {
  return (
    <Button asChild size="sm">
      <a
        href="https://github.com/mrlightful/create-tauri-react"
        rel="noreferrer"
        target="_blank"
      >
        <Star className="mr-1" size={16} /> Star Github
      </a>
    </Button>
  );
}
