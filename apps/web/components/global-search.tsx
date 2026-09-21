import { Button, Input } from "@bea/ui";

export function GlobalSearch() {
  return (
    <form action="/search" className="bea-global-search" role="search">
      <label className="bea-visually-hidden" htmlFor="global-search-query">
        Search Command Center records
      </label>
      <Input
        id="global-search-query"
        name="q"
        type="search"
        placeholder="Search records"
        autoComplete="off"
      />
      <Button type="submit" size="small" variant="secondary">
        Search
      </Button>
    </form>
  );
}
