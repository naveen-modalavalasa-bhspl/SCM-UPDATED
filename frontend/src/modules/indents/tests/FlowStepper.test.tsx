import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FlowStepper } from "../components/FlowStepper";

describe("FlowStepper", () => {
  it("shows the lifecycle steps", () => {
    render(<FlowStepper status="PENDING_APPROVAL" />);
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("In approval")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
  });

  it("renders a Rejected slot when rejected", () => {
    render(<FlowStepper status="REJECTED" />);
    expect(screen.getByText("Rejected")).toBeInTheDocument();
  });
});
