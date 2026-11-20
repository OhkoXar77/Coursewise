(() => {
  document.querySelectorAll("[data-table-tools]").forEach((tools) => {
    const search = tools.closest(".panel")?.querySelector("[data-table-search]") ||
      document.querySelector("[data-table-search]");
    const rows = [...tools.querySelectorAll("[data-filter-row]")];
    const empty = tools.querySelector("[data-filter-empty]");
    const count = document.querySelector("[data-record-count]");
    const singular = count?.dataset.recordSingular || "record";
    const label = count?.dataset.recordLabel || `${singular}s`;

    function filterRows() {
      const query = (search?.value || "").trim().toLocaleLowerCase();
      let visible = 0;
      rows.forEach((row) => {
        const matches = !query || (row.dataset.search || row.textContent).toLocaleLowerCase().includes(query);
        row.hidden = !matches;
        if (matches) visible += 1;
      });
      if (empty) empty.hidden = visible !== 0;
      if (count) count.textContent = `${visible} ${visible === 1 ? singular : label}`;
    }

    search?.addEventListener("input", filterRows);
    filterRows();

    tools.querySelectorAll("[data-sort-column]").forEach((button) => {
      button.addEventListener("click", () => {
        const table = tools.querySelector("[data-sortable-table]");
        const body = table?.tBodies[0];
        if (!body) return;
        const column = Number(button.dataset.sortColumn);
        const header = button.closest("th");
        const ascending = header?.getAttribute("aria-sort") !== "ascending";
        table.querySelectorAll("th[aria-sort]").forEach((cell) => cell.setAttribute("aria-sort", "none"));
        header?.setAttribute("aria-sort", ascending ? "ascending" : "descending");
        const sorted = [...body.rows].sort((a, b) => {
          const aCell = a.cells[column];
          const bCell = b.cells[column];
          const left = (aCell?.dataset.sortValue ?? aCell?.textContent ?? "").trim();
          const right = (bCell?.dataset.sortValue ?? bCell?.textContent ?? "").trim();
          return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }) * (ascending ? 1 : -1);
        });
        sorted.forEach((row) => body.append(row));
      });
    });
  });
})();
