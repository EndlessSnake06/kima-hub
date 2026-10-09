import { AxiosError } from "axios";
import { logger } from "../logger";

it("logs a failed request as one line without its query string", () => {
    const spy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const err = new AxiosError("timeout of 10000ms exceeded", "ECONNABORTED", {
        method: "get",
        baseURL: "https://query.wikidata.org",
        url: "/sparql?query=x&api_key=secret",
        headers: {} as never,
    });
    logger.warn("Wikidata fetch failed:", err, 7);
    const printed = spy.mock.calls[0].slice(1);
    expect(printed).toEqual(["timeout of 10000ms exceeded (ECONNABORTED, GET https://query.wikidata.org/sparql)", 7]);
    expect(JSON.stringify(printed)).not.toContain("secret");
    spy.mockRestore();
});
