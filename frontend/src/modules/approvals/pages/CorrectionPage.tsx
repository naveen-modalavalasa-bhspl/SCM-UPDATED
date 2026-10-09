import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";

export function ApprovalCorrectionPage({
  indentId: suppliedIndentId,
  onClose,
}: { indentId?: number; onClose?: () => void } = {}) {
  const { id } = useParams();
  const indentId = suppliedIndentId ?? Number(id);
  const nav = useNavigate();

  useEffect(() => {
    if (!Number.isFinite(indentId) || indentId <= 0) {
      if (onClose) onClose();
      else nav("/approvals", { replace: true });
      return;
    }
    nav(`/indents/${indentId}`, { replace: true });
  }, [indentId, nav, onClose]);

  return <p className="p-6 text-sm text-muted">Opening indent correction...</p>;
}
