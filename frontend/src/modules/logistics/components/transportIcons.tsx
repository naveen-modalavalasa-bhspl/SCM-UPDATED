/** A face for each way a load can travel, and for each arrangement it can travel under.
 *
 * Decoration only. The RULES — which carriages exist, which arrangements each one
 * allows, what each requires — are served (`/api/transport/carriage-modes` and
 * `/api/transport/modes`) and are never restated here; `modeCopy.ts` owns the short
 * label and the tint. This file exists so the dispatch desk and the carrier's portal
 * draw the same four icons against the same four values, instead of each keeping a
 * private map and quietly disagreeing about what a sea leg looks like.
 */
import type { ReactNode } from "react";
import { Gavel, Handshake, Package, Plane, Ship, TrainFront, Truck } from "lucide-react";

import type { CarriageMode, TransportMode } from "../transportTypes";

export const CARRIAGE_ICON: Record<CarriageMode, ReactNode> = {
  ROAD: <Truck className="h-4 w-4" />,
  RAIL: <TrainFront className="h-4 w-4" />,
  AIR: <Plane className="h-4 w-4" />,
  SEA: <Ship className="h-4 w-4" />,
};

export const MODE_ICON: Record<TransportMode, ReactNode> = {
  DIRECT: <Handshake className="h-4 w-4" />,
  OWN_VEHICLE: <Truck className="h-4 w-4" />,
  COURIER: <Package className="h-4 w-4" />,
  THIRD_PARTY: <Gavel className="h-4 w-4" />,
};

export const carriageIcon = (value?: string | null): ReactNode =>
  CARRIAGE_ICON[value as CarriageMode] ?? CARRIAGE_ICON.ROAD;

export const modeIcon = (value?: string | null): ReactNode =>
  MODE_ICON[value as TransportMode] ?? MODE_ICON.DIRECT;
