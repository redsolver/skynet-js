import axios from "axios";
import MockAdapter from "axios-mock-adapter";

import { SkynetClient, defaultSkynetPortalUrl } from "./index";
import { trimForwardSlash } from "./utils";

const portalUrl = defaultSkynetPortalUrl;
const hnsLink = "foo";
const client = new SkynetClient(portalUrl);
const skylink = "XABvi7JtJbQSMAcDwnUnmp2FKDPjg8_tTTFP4BwMSxVdEg";

const attachment = "?attachment=true";
const validSkylinkVariations = [
  [skylink, ""],
  [`${skylink}?foo=bar`, ""],
  [`${skylink}/foo/bar`, "/foo/bar"],
  [`${skylink}#foobar`, ""],
  [`sia:${skylink}`, ""],
  [`sia://${skylink}`, ""],
  [`${portalUrl}/${skylink}`, ""],
  [`${portalUrl}/${skylink}/`, ""],
  [`${portalUrl}/${skylink}/foo/bar`, "/foo/bar"],
  [`${portalUrl}/${skylink}/foo%3Fbar`, "/foo%3Fbar"],
  [`${portalUrl}/${skylink}/foo/bar?foo=bar`, "/foo/bar"],
  [`${portalUrl}/${skylink}?foo=bar`, ""],
  [`${portalUrl}/${skylink}#foobar`, ""],
];
const validHnsLinkVariations = [hnsLink, `hns:${hnsLink}`, `hns://${hnsLink}`];
const validHnsresLinkVariations = [hnsLink, `hnsres:${hnsLink}`, `hnsres://${hnsLink}`];

const expectedUrl = `${portalUrl}/${skylink}`;
const expectedHnsUrl = `${portalUrl}/hns/${hnsLink}`;
const expectedHnsUrlSubdomain = `https://${hnsLink}.hns.siasky.net`;
const expectedHnsresUrl = `${portalUrl}/hnsres/${hnsLink}`;

const mockLocationAssign = jest.fn();
Object.defineProperty(window, "location", {
  value: {
    assign: mockLocationAssign,
  },
  writable: true,
});

describe("downloadFile", () => {
  it("should download with a skylink url with attachment set", () => {
    validSkylinkVariations.forEach(([fullSkylink, path]) => {
      mockLocationAssign.mockClear();
      const url = client.downloadFile(fullSkylink);

      let expectedUrl2 = `${expectedUrl}${path}${attachment}`;
      if (path.startsWith("#")) {
        // Hash should come after query.
        expectedUrl2 = `${expectedUrl}${attachment}${path}`;
      }
      // Change ?attachment=true to &attachment=true if need be.
      if ((expectedUrl2.match(/\?/g) || []).length > 1) {
        expectedUrl2 = expectedUrl2.replace(attachment, "&attachment=true");
      }
      expect(url).toEqual(expectedUrl2);
      expect(mockLocationAssign).toHaveBeenCalledWith(expectedUrl2);
    });
  });

  it("should download with the optional path being correctly URI-encoded", () => {
    const url = client.downloadFile(skylink, { path: "dir/test?encoding" });

    expect(url).toEqual(`${expectedUrl}/dir/test%3Fencoding${attachment}`);
  });

  it("should download with query parameters being appended to the URL", () => {
    const url = client.downloadFile(skylink, { query: { name: "test" } });

    expect(url).toEqual(`${expectedUrl}?name=test&attachment=true`);
  });
});

describe("downloadFileHns", () => {
  it("should download with the correct hns link", async () => {
    for (const input of validHnsLinkVariations) {
      const url = await client.downloadFileHns(input);

      expect(url).toEqual(`${expectedHnsUrl}${attachment}`);
    }
  });
});

describe("getHnsUrl", () => {
  it("should return correctly formed hns URL", () => {
    validHnsLinkVariations.forEach((input) => {
      expect(client.getHnsUrl(input)).toEqual(expectedHnsUrl);
      expect(client.getHnsUrl(input, { subdomain: true })).toEqual(expectedHnsUrlSubdomain);
    });
  });

  it("should return correctly formed hns URL with forced download", () => {
    const url = client.getHnsUrl(hnsLink, { download: true });

    expect(url).toEqual(`${expectedHnsUrl}${attachment}`);
  });
});

describe("getHnsresUrl", () => {
  it("should return correctly formed hnsres URL", () => {
    validHnsresLinkVariations.forEach((input) => {
      expect(client.getHnsresUrl(input)).toEqual(expectedHnsresUrl);
    });
  });
});

describe("getSkylinkUrl", () => {
  const expectedUrl = `${portalUrl}/${skylink}`;

  it("should return correctly formed skylink URL", () => {
    validSkylinkVariations.forEach(([fullSkylink, path]) => {
      expect(client.getSkylinkUrl(fullSkylink)).toEqual(`${expectedUrl}${path}`);
    });
  });

  it("should return correctly formed URLs when path is given", () => {
    expect(client.getSkylinkUrl(skylink, { path: "foo/bar" })).toEqual(`${expectedUrl}/foo/bar`);
    expect(client.getSkylinkUrl(skylink, { path: "foo?bar" })).toEqual(`${expectedUrl}/foo%3Fbar`);
  });

  it("should return correctly formed URL with forced download", () => {
    const url = client.getSkylinkUrl(skylink, { download: true, endpointPath: "skynet/skylink" });

    expect(url).toEqual(`${portalUrl}/skynet/skylink/${skylink}${attachment}`);
  });

  it("should return correctly formed URLs with forced download and path", () => {
    expect(client.getSkylinkUrl(skylink, { download: true, path: "foo?bar" })).toEqual(
      `${expectedUrl}/foo%3Fbar${attachment}`
    );
  });

  it("should convert base64 skylinks to base32", () => {
    const expectedBase32 = "https://bg06v2tidkir84hg0s1s4t97jaeoaa1jse1svrad657u070c9calq4g.siasky.net";

    validSkylinkVariations.forEach(([input, path]) => {
      const url = client.getSkylinkUrl(input, { subdomain: true });

      expect(url).toEqual(`${expectedBase32}${path}`);
    });
  });
});

describe("getMetadata", () => {
  let mock: MockAdapter;

  beforeEach(() => {
    mock = new MockAdapter(axios);
  });

  it("should fetch successfully skynet file headers", () => {
    const skynetFileMetadata = { filename: "sia.pdf" };
    const headers = { "skynet-skylink": skylink, "skynet-file-metadata": JSON.stringify(skynetFileMetadata) };

    validSkylinkVariations.forEach(async ([input]) => {
      const skylinkUrl = client.getSkylinkUrl(input);
      mock.onHead(skylinkUrl).reply(200, {}, headers);

      const responseMetadata = await client.getMetadata(input);

      expect(responseMetadata).toEqual(skynetFileMetadata);
    });
  });

  it("should fail quietly when skynet headers not present", () => {
    const headers = { "skynet-skylink": skylink };

    validSkylinkVariations.forEach(async ([input]) => {
      const skylinkUrl = client.getSkylinkUrl(input);
      mock.onHead(skylinkUrl).reply(200, {}, headers);

      const responseMetadata = await client.getMetadata(input);

      expect(responseMetadata).toEqual({});
    });
  });
});

describe("openFile", () => {
  it("should call window.openFile", () => {
    const windowOpen = jest.spyOn(window, "open").mockImplementation();

    validSkylinkVariations.forEach(([fullSkylink, path]) => {
      windowOpen.mockReset();

      client.openFile(fullSkylink);

      expect(windowOpen).toHaveBeenCalledTimes(1);
      expect(windowOpen).toHaveBeenCalledWith(`${expectedUrl}${path}`, "_blank");
    });
  });
});

describe("downloadFileHns", () => {
  it("should set domain with the portal and hns link and then call window.openFile with attachment set", async () => {
    for (const input of validHnsLinkVariations) {
      mockLocationAssign.mockClear();

      await client.downloadFileHns(input);

      expect(mockLocationAssign).toHaveBeenCalledWith("https://siasky.net/hns/foo?attachment=true");
    }
  });
});

describe("openFileHns", () => {
  const hnsUrl = `${portalUrl}/hns/${hnsLink}`;
  let mock: MockAdapter;

  beforeEach(() => {
    mock = new MockAdapter(axios);
  });

  it("should set domain with the portal and hns link and then call window.openFile", async () => {
    const windowOpen = jest.spyOn(window, "open").mockImplementation();

    for (const input of validHnsLinkVariations) {
      mock.resetHistory();
      windowOpen.mockReset();

      await client.openFileHns(input);

      expect(mock.history.get.length).toBe(0);

      expect(windowOpen).toHaveBeenCalledTimes(1);
      expect(windowOpen).toHaveBeenCalledWith(hnsUrl, "_blank");
    }
  });
});

describe("resolveHns", () => {
  let mock: MockAdapter;

  beforeEach(() => {
    mock = new MockAdapter(axios);
    mock.onGet(expectedHnsresUrl).reply(200, { skylink: skylink });
  });

  it("should call axios.get with the portal and hnsres link and return the json body", async () => {
    for (const input of validHnsresLinkVariations) {
      mock.resetHistory();

      const data = await client.resolveHns(input);

      expect(mock.history.get.length).toBe(1);
      expect(data.skylink).toEqual(skylink);
    }
  });
});
