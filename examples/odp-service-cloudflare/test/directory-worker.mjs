import { createDirectoryClient } from "@offering-protocol/directory";

export default {
  async fetch() {
    const directory = createDirectoryClient();
    const pages = [];
    for await (const page of directory.searchServices({ query: "templates" }).pages) {
      pages.push(page);
    }
    return Response.json(pages);
  }
};
