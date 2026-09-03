import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import { Copy, Eye, EyeOff, KeyRound, RotateCcw } from "lucide-react";
import { Button, Card, ConfirmModal, Field, Input, useToast } from "@/shared/components";
import { writeToClipboard } from "./Copyable";
import type { IntegrationSecretReveal, IntegrationSecretState } from "../types";

export function SecretRevealSection({
  queryKey,
  stateFn,
  revealFn,
  description,
  copiedMessage = "Secret key copied",
  onRevealed,
  rotateFn,
  rotateWarning,
}: {
  queryKey: readonly unknown[];
  stateFn: () => Promise<IntegrationSecretState>;
  revealFn: (password?: string) => Promise<IntegrationSecretReveal>;
  description: string;
  copiedMessage?: string;
  onRevealed?: () => void;
  /** Mint a NEW secret, replacing the one in use. Optional because only a server
   *  that stores the secret recoverably can rotate it; today that is webhooks, the
   *  one place a shared secret survives (2026-09-01). */
  rotateFn?: () => Promise<{ shared_secret: string }>;
  /** What breaks between the press and the sender being given the new value. */
  rotateWarning?: React.ReactNode;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState<string | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [rotateAsking, setRotateAsking] = useState(false);

  const state = useQuery({ queryKey, queryFn: stateFn });

  const reveal = useMutation({
    mutationFn: revealFn,
    onSuccess: (result) => {
      setSecret(result.shared_secret);
      setNeedsPassword(true);
      setPassword("");
      setPasswordError("");
      setPasswordOpen(false);
      void queryClient.invalidateQueries({ queryKey });
      onRevealed?.();
    },
  });

  /* Replacing the secret in use. It is the one press here that breaks a working
   * integration on somebody else's machine — every push signed with the old value is
   * refused from the moment it lands — so it asks first, and the new value is shown
   * in the panel exactly as a reveal is, ready to be copied and sent on. */
  const rotate = useMutation({
    mutationFn: () => rotateFn!(),
    onSuccess: (result) => {
      setSecret(result.shared_secret);
      // A freshly minted secret has not been "revealed" yet in the sense the password
      // gate means, but it has been SEEN — so the next look asks, like any other.
      setNeedsPassword(true);
      setRotateAsking(false);
      void queryClient.invalidateQueries({ queryKey });
      onRevealed?.();
      toast.success("New secret issued — copy it and send it to them now");
    },
    onError: () => toast.error("That secret could not be replaced."),
  });

  useEffect(() => {
    if (!secret) return undefined;
    const timer = window.setTimeout(() => setSecret(null), 30000);
    return () => window.clearTimeout(timer);
  }, [secret]);

  const closePassword = () => {
    setPasswordOpen(false);
    setPassword("");
    setPasswordError("");
  };

  const askOrReveal = () => {
    setPasswordError("");
    if (secret) {
      setSecret(null);
      return;
    }
    if (needsPassword || state.data?.needs_password) {
      setPasswordOpen(true);
      return;
    }
    reveal.mutate(undefined, {
      onError: (error) => {
        if ((error as { response?: { status?: number } }).response?.status === 403) {
          toast.error((error as Error).message || "You do not have permission to reveal this secret.");
          return;
        }
        setPasswordOpen(true);
        setPasswordError((error as Error).message || "Enter the password to reveal this secret.");
      },
    });
  };

  const verify = () => {
    if (!password || reveal.isPending) return;
    setPasswordError("");
    reveal.mutate(password, {
      onError: (error) =>
        setPasswordError((error as Error).message || "Password is incorrect. Please try again."),
    });
  };

  const copy = async () => {
    if (!secret) return;
    try {
      const ok = await writeToClipboard(secret);
      if (!ok) throw new Error("Copy failed");
      toast.success(copiedMessage);
    } catch {
      toast.error("Secret key could not be copied.");
    } finally {
      setSecret(null);
    }
  };

  return (
    <>
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-ink">
              <KeyRound className="h-4 w-4 text-brand" />
              Secret Key
            </div>
            <p className="mt-1 max-w-2xl text-xs text-muted">{description}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" disabled={state.isLoading || reveal.isPending} onClick={askOrReveal}>
              {secret
                ? <><EyeOff className="h-4 w-4" /> Hide</>
                : <><Eye className="h-4 w-4" /> {reveal.isPending ? "Revealing..." : "Reveal"}</>}
            </Button>
            {/* Only where the server can actually mint one, and only once one exists
                — before that, Reveal issues the first secret and "Replace" would be
                a second word for the same thing. */}
            {rotateFn && state.data?.has_secret && (
              <Button variant="ghost" disabled={rotate.isPending}
                      onClick={() => setRotateAsking(true)}>
                <RotateCcw className="h-4 w-4" /> Replace
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code
            className={`flex min-h-11 flex-1 items-center overflow-hidden rounded-lg border
                        border-line bg-content2 px-3 py-2 font-mono text-xs ${
                          secret
                            ? "break-all text-ink"
                            : "select-none whitespace-nowrap text-muted blur-[1.5px]"
                        }`}
          >
            {secret ?? "scm_........................................"}
          </code>
          <Button variant="subtle" disabled={!secret || reveal.isPending} onClick={copy}>
            <Copy className="h-4 w-4" /> Copy
          </Button>
        </div>
      </Card>

      <ConfirmModal
        isOpen={rotateAsking}
        title="Replace this secret?"
        message={rotateWarning ?? (
          <>
            A new secret is minted and the current one stops working immediately.
            Anything still signing with the old value is refused until the sender has
            been given the new one. There is no undo — the old secret is gone.
          </>
        )}
        confirmLabel="Replace it"
        danger
        busy={rotate.isPending}
        error={rotate.error}
        onConfirm={() => rotate.mutate()}
        onClose={() => setRotateAsking(false)}
      />

      <Modal isOpen={passwordOpen} onClose={closePassword} size="sm">
        <ModalContent>
          <ModalHeader className="font-display text-lg font-bold text-ink">
            Verify password
          </ModalHeader>
          <ModalBody>
            <Field label="Password">
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") verify();
                }}
                autoFocus
              />
            </Field>
            {passwordError && <p className="text-sm text-danger">{passwordError}</p>}
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={closePassword}>Cancel</Button>
            <Button disabled={reveal.isPending || !password} onClick={verify}>
              {reveal.isPending ? "Verifying..." : "Reveal"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
