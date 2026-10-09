/**
 * Region/Location filtering: URL state and the request it produces (Phase 2).
 *
 * Region is the HCM location the requester is tagged to, snapshotted on the indent at
 * create. It is read-only in the UI, so what is worth testing here is the filtering:
 * that a shared URL round-trips, that junk ids are rejected before they reach the API,
 * and that "no location" stays a separate opt-in from picking locations by id.
 *
 * The page-level rendering tests (Region column, read-only field on the form and
 * detail screens) live in IndentPages.test.tsx, which already mocks the api module.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { indentApi } from "../api";
import {
  normalizeAllRequestsSearch,
  parseRegionIds,
} from "../context/AllRequestsUrlState";
import { normalizeSimpleIndentFilterSearch } from "../context/SimpleIndentFiltersUrlState";
import { INDENT_ACTIVITY_EVENT_FILTER_OPTIONS } from "../constants";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/shared/api/client", () => ({ api: apiMock }));

function paramsOf(call: unknown[]) {
  const config = call[1] as { params: URLSearchParams };
  return config.params;
}

describe("region ids off the URL", () => {
  it("keeps positive integers, deduped and sorted", () => {
    expect(parseRegionIds(["937", "654", "937"])).toEqual([654, 937]);
  });

  it("drops anything that is not a positive integer id", () => {
    // HCM owns the locations, so there is no closed option list to validate against.
    // Rejecting unknown-but-well-formed ids is the backend's job — it returns no rows.
    expect(parseRegionIds([
      "0", "-1", "1.5", "abc", "", " 654", "1e3", "99999999999999999999",
    ])).toEqual([]);
  });
});

describe("All Requests URL state", () => {
  it("round-trips region ids and the unassigned flag", () => {
    const { params, state } = normalizeAllRequestsSearch(
      "region_id=937&region_id=654&region_unassigned=1",
    );

    expect(state.selectedRegions).toEqual([654, 937]);
    expect(state.includeUnassignedRegion).toBe(true);
    expect(params.getAll("region_id")).toEqual(["654", "937"]);
    expect(params.get("region_unassigned")).toBe("1");
  });

  it("treats region ids and 'no location' as independent choices", () => {
    const idsOnly = normalizeAllRequestsSearch("region_id=654").state;
    const unassignedOnly = normalizeAllRequestsSearch("region_unassigned=1").state;

    expect(idsOnly.selectedRegions).toEqual([654]);
    expect(idsOnly.includeUnassignedRegion).toBe(false);
    expect(unassignedOnly.selectedRegions).toEqual([]);
    expect(unassignedOnly.includeUnassignedRegion).toBe(true);
  });

  it("strips a malformed region filter from the canonical URL", () => {
    const { params, state } = normalizeAllRequestsSearch(
      "region_id=not-an-id&region_unassigned=yes",
    );

    expect(state.selectedRegions).toEqual([]);
    expect(state.includeUnassignedRegion).toBe(false);
    expect(params.toString()).toBe("");
  });

  it("leaves a URL with no region filter completely alone", () => {
    const { state } = normalizeAllRequestsSearch("status=DRAFT");

    expect(state.selectedRegions).toEqual([]);
    expect(state.includeUnassignedRegion).toBe(false);
  });
});

describe("activity ledger URL state", () => {
  const options = {
    selectionParam: "transaction_type",
    selectionOptions: INDENT_ACTIVITY_EVENT_FILTER_OPTIONS,
    singleSelection: true,
  };

  it("carries the same region filter as the list", () => {
    const { params, state } = normalizeSimpleIndentFilterSearch(
      "region_id=654&region_unassigned=1",
      options,
    );

    expect(state.selectedRegions).toEqual([654]);
    expect(state.includeUnassignedRegion).toBe(true);
    expect(params.getAll("region_id")).toEqual(["654"]);
  });

  it("survives alongside an event filter without dropping either", () => {
    const { state } = normalizeSimpleIndentFilterSearch(
      "transaction_type=STOCK_ALLOCATED&region_id=937",
      options,
    );

    expect(state.selectedStatuses).toEqual(["STOCK_ALLOCATED"]);
    expect(state.selectedRegions).toEqual([937]);
  });
});

describe("region requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.get.mockResolvedValue({ data: { items: [] } });
  });

  it("sends one region_id parameter per selected location", async () => {
    await indentApi.list({ region_id: [654, 937], region_unassigned: true });
    const params = paramsOf(apiMock.get.mock.calls[0]);

    expect(params.getAll("region_id")).toEqual(["654", "937"]);
    expect(params.get("region_unassigned")).toBe("true");
  });

  it("omits the region filter entirely when nothing is selected", async () => {
    await indentApi.list({ region_id: [], region_unassigned: undefined });
    const params = paramsOf(apiMock.get.mock.calls[0]);

    expect(params.has("region_id")).toBe(false);
    expect(params.has("region_unassigned")).toBe(false);
  });

  it("filters the activity ledger by region too", async () => {
    await indentApi.activity({ region_id: [654] });
    const [url, config] = apiMock.get.mock.calls[0] as [string, { params: URLSearchParams }];

    expect(url).toBe("/api/indents/activity");
    expect(config.params.getAll("region_id")).toEqual(["654"]);
  });

  it("reads the option list from the indents module, not a master endpoint", async () => {
    // Raising or filtering an indent must not require a masters permission, the same
    // reason vehicles are served from /api/indents rather than the warehouse.
    apiMock.get.mockResolvedValue({
      data: { items: [{ id: 654, name: "104-MMU-AP-Hanumanthunipadu" }] },
    });

    const regions = await indentApi.regions();

    expect(apiMock.get).toHaveBeenCalledWith("/api/indents/options/regions");
    expect(regions).toEqual([{ id: 654, name: "104-MMU-AP-Hanumanthunipadu" }]);
  });
});
