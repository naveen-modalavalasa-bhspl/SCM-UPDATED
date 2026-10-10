import { Alert, Button, Can, ErrorBanner } from "@/shared/components";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, MapPinOff } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { getUnlocatedStock, placeUnlocatedStock } from "../api";
import { fmtQty } from "../format";

/**
 * Stock this warehouse received before it kept storage locations.
 *
 * A warehouse that keeps no locations banks its GRNs at "no location". Switched to
 * keeping them, that old stock used to be unreachable — every issue and movement
 * picker asks for a location, and it had none. The server now gives it the
 * warehouse's **Unlocated** location (backend `warehouse/unlocated.py`); this card
 * says where it went and how much is still waiting there to be put on a real shelf.
 *
 * Nothing renders on a warehouse with nothing unlocated, so a site that never had
 * the problem never sees the card.
 */
export function UnlocatedStockCard({ warehouseId }: { warehouseId: number }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["wh-unlocated", warehouseId],
    queryFn: () => getUnlocatedStock(warehouseId),
    enabled: !!warehouseId,
  });

  const place = useMutation({
    mutationFn: () => placeUnlocatedStock(warehouseId),
    onSuccess: (next) => {
      qc.setQueryData(["wh-unlocated", warehouseId], next);
      qc.invalidateQueries({ queryKey: ["wh-bins", String(warehouseId)] });
    },
  });

  if (!data?.is_bin_managed) return null;
  const pending = data.pending_rows > 0;
  const held = data.held_rows > 0;
  if (!pending && !held) return null;

  return (
    <div className="mb-4 space-y-3">
      <ErrorBanner error={place.error} />
      {pending && (
        <Alert
          tone="warning"
          title={`${fmtQty(data.pending_qty)} in stock with no storage location`}
          action={
            <Can do="master.location.manage">
              <Button onClick={() => place.mutate()} disabled={place.isPending}>
                <MapPinOff className="h-4 w-4" />
                {place.isPending ? "Placing…" : "Place in Unlocated"}
              </Button>
            </Can>
          }
        >
          Received before this warehouse kept locations ({data.pending_rows} stock
          row{data.pending_rows === 1 ? "" : "s"}). It is placed in the Unlocated
          location so it can be issued and moved — automatically on the next pick, or
          now.
        </Alert>
      )}
      {held && (
        <Alert
          tone="info"
          title={`${fmtQty(data.held_qty)} of ${data.held_items} item${
            data.held_items === 1 ? "" : "s"} waiting in ${data.location_code}`}
          action={
            <Button variant="ghost" onClick={() => nav("/warehouse/stock-movements/new")}>
              <ArrowRightLeft className="h-4 w-4" /> Move to a location
            </Button>
          }
        >
          Stock received before this warehouse kept locations. It can be issued from{" "}
          {data.location_code} like any other location; move it to the shelf it
          actually sits on and {data.location_code} simply reads empty.
          {place.data && place.data.placed_rows > 0 && (
            <> Just placed: {fmtQty(place.data.placed_qty)} in {place.data.placed_rows} row
              {place.data.placed_rows === 1 ? "" : "s"}
              {place.data.placed_units ? `, ${place.data.placed_units} units` : ""}.</>
          )}
        </Alert>
      )}
    </div>
  );
}
