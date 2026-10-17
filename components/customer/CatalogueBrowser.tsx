"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Filter, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Badge, Button, Card, Spinner, toast } from "@/components/ui";
import { api, formatRupees } from "@/lib/client";

/**
 * Browsing the catalogue.
 *
 * Exists next to search rather than instead of it, because "show me my blood
 * pressure tablets" is not a fuzzy-string problem — the customer knows the
 * category, not the brand. Forcing someone through a search box to reach a
 * category is a worse interface than letting them browse.
 *
 * Three things on this screen are deliberately not merged:
 *
 *  - **availability** comes from live inventory and is shown per row, including
 *    "0 in stock" — a catalogue entry existing is not a claim that anyone has it;
 *  - **prescription status** is a catalogue fact, shown as a badge, never
 *    inferred and never used to rank;
 *  - **price** is a fictional demo figure, and the footer says so.
 */

interface CatalogueRow {
  id: number;
  display_name: string;
  generic_name: string;
  brand_name: string | null;
  ingredients: string | null;
  strength_value: number | null;
  strength_unit: string | null;
  dosage_form: string;
  route: string | null;
  category: string;
  subcategory: string | null;
  therapeutic_class: string | null;
  requires_prescription: number;
  rx_basis: string | null;
  verification_status: string;
  package_size: string | null;
  price_paise: number;
  in_stock: number;
  pharmacy_count: number;
}

interface CatalogueResponse {
  medicines: CatalogueRow[];
  pagination: { total: number; limit: number; offset: number; pages: number; hasMore: boolean };
  facets: Record<string, string[]>;
  note: string;
}

const PAGE = 24;

export default function CatalogueBrowser({ onPick }: { onPick?: (id: number) => void }) {
  const [data, setData] = useState<CatalogueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [form, setForm] = useState("");
  const [rx, setRx] = useState("");
  const [inStock, setInStock] = useState(false);
  const [sort, setSort] = useState("relevance");
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      limit: String(PAGE),
      offset: String(page * PAGE),
      sort,
    });
    if (q) params.set("q", q);
    if (category) params.set("category", category);
    if (form) params.set("form", form);
    if (rx) params.set("rx", rx);
    if (inStock) params.set("inStock", "true");
    try {
      const res = await api.get<CatalogueResponse>(`/api/catalogue?${params.toString()}`);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the catalogue");
    } finally {
      setLoading(false);
    }
  }, [q, category, form, rx, inStock, sort, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // Any filter change invalidates the page number; staying on page 7 of a new
  // result set shows nothing at all, which reads as "the filter found nothing".
  const setFilter = (fn: () => void) => {
    setPage(0);
    fn();
  };

  const activeFilters = useMemo(
    () =>
      [category && `category: ${category}`, form && `form: ${form}`, rx && (rx === "true" ? "prescription only" : "over the counter"), inStock && "in stock now"]
        .filter(Boolean) as string[],
    [category, form, rx, inStock]
  );

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-semibold text-slate-900">
          <Filter className="h-4 w-4 text-slate-400" /> Browse the catalogue
        </h2>
        <select
          value={sort}
          onChange={(e) => setFilter(() => setSort(e.target.value))}
          aria-label="Sort results"
          className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm"
        >
          <option value="relevance">Most in stock</option>
          <option value="name">Name A–Z</option>
          <option value="brand">Brand A–Z</option>
          <option value="price_asc">Price: low to high</option>
          <option value="price_desc">Price: high to low</option>
        </select>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm text-slate-600">
          <span className="mb-1 block text-xs font-medium text-slate-500">Search</span>
          <input
            value={q}
            onChange={(e) => setFilter(() => setQ(e.target.value))}
            placeholder="name, brand or ingredient"
            className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
          />
        </label>
        <label className="text-sm text-slate-600">
          <span className="mb-1 block text-xs font-medium text-slate-500">Category</span>
          <select
            value={category}
            onChange={(e) => setFilter(() => setCategory(e.target.value))}
            className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            <option value="">All categories</option>
            {(data?.facets.category ?? []).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-slate-600">
          <span className="mb-1 block text-xs font-medium text-slate-500">Dosage form</span>
          <select
            value={form}
            onChange={(e) => setFilter(() => setForm(e.target.value))}
            className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            <option value="">Any form</option>
            {(data?.facets.form ?? []).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-slate-600">
          <span className="mb-1 block text-xs font-medium text-slate-500">Prescription</span>
          <select
            value={rx}
            onChange={(e) => setFilter(() => setRx(e.target.value))}
            className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            <option value="">Any</option>
            <option value="false">Over the counter</option>
            <option value="true">Prescription only</option>
          </select>
        </label>
      </div>

      <label className="mt-3 inline-flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={inStock}
          onChange={(e) => setFilter(() => setInStock(e.target.checked))}
        />
        Only show what is in stock right now
      </label>

      {activeFilters.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {activeFilters.map((f) => (
            <Badge key={f} tone="slate">
              {f}
            </Badge>
          ))}
          <button
            className="text-xs text-teal-700 underline"
            onClick={() =>
              setFilter(() => {
                setCategory("");
                setForm("");
                setRx("");
                setInStock(false);
              })
            }
          >
            clear filters
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
          {error}{" "}
          <button className="underline" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : loading ? (
        <Spinner className="mt-4 h-6 w-6 text-teal-600" />
      ) : data && data.medicines.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-6 text-center">
          <p className="text-sm text-slate-600">Nothing matches those filters.</p>
          <p className="mt-1 text-xs text-slate-400">
            The catalogue holds {data.pagination.total === 0 ? "no" : ""} entries for this
            combination. Try widening the category.
          </p>
        </div>
      ) : (
        <>
          <p className="mt-4 text-xs text-slate-500">
            {data?.pagination.total ?? 0} catalogue entries
            {activeFilters.length ? " matching your filters" : ""}
          </p>
          <div className="mt-2 divide-y divide-slate-100">
            {data?.medicines.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-900">{m.display_name}</span>
                    {m.requires_prescription ? (
                      // The basis is on the row itself rather than a tooltip:
                      // "curated" is a meaningful thing to see, and tooltips are
                      // invisible on touch.
                      <span className="inline-flex items-center gap-1">
                        <Badge tone="amber">Rx</Badge>
                        <span className="text-[10px] text-slate-400">({m.rx_basis})</span>
                      </span>
                    ) : null}
                    {m.verification_status === "demo" ? <Badge tone="rose">demo data</Badge> : null}
                  </div>
                  <p className="text-xs text-slate-500">
                    {m.category}
                    {m.subcategory ? ` · ${m.subcategory}` : ""}
                    {m.therapeutic_class ? ` · ${m.therapeutic_class}` : ""}
                    {m.package_size ? ` · ${m.package_size}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3 text-right">
                  <div>
                    <p className="font-medium text-slate-900">{formatRupees(m.price_paise)}</p>
                    <p className="text-xs text-slate-400">demo price</p>
                  </div>
                  <div>
                    {m.in_stock > 0 ? (
                      <p className="text-sm text-emerald-700">
                        {m.in_stock} in stock
                        <span className="block text-xs text-slate-400">
                          {m.pharmacy_count} pharmac{m.pharmacy_count === 1 ? "y" : "ies"}
                        </span>
                      </p>
                    ) : (
                      <p className="text-sm text-slate-400">Not stocked</p>
                    )}
                  </div>
                  {onPick ? (
                    <Button
                      className="text-xs"
                      disabled={m.in_stock === 0}
                      onClick={() => {
                        onPick(m.id);
                        toast(`Selected ${m.display_name}`, "success");
                      }}
                    >
                      {m.in_stock > 0 ? "Select" : "Unavailable"}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          {data && data.pagination.pages > 1 ? (
            <div className="mt-4 flex items-center justify-between">
              <Button variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft className="h-4 w-4" /> Previous
              </Button>
              <span className="text-xs text-slate-500">
                Page {page + 1} of {data.pagination.pages}
              </span>
              <Button
                variant="ghost"
                disabled={!data.pagination.hasMore}
                onClick={() => setPage((p) => p + 1)}
              >
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          ) : null}

          {data ? (
            <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-400">
              <Search className="mr-1 inline h-3 w-3" />
              {data.note}
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}