import { Button } from "@/components/ui/button";
import {
  ErrorActions,
  ErrorDescription,
  ErrorHeader,
  ErrorView,
} from "@/features/errors/error-base";

export default function AppErrorPage() {
  return (
    <ErrorView>
      <ErrorHeader>We&apos;re fixing it</ErrorHeader>
      <ErrorDescription>
        The app encountered an error and needs to be restarted.
        <br />
        We know about it and we&apos;re working to fix it.
      </ErrorDescription>
      <ErrorActions>
        <Button
          onClick={() => {
            window.location.reload();
          }}
          size="lg"
        >
          Relaunch app
        </Button>
      </ErrorActions>
    </ErrorView>
  );
}
