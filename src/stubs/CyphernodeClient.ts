// Stub responses for CyphernodeClient — used when STUB_MODE=true.
// Unknown endpoints return 403 so that the _post/_get 403 tests still pass.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CYPHERNODE_STUBS: { GET: Record<string, (data?: any) => any>; POST: Record<string, (data?: any) => any> } = {
  GET: {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    "/getblockchaininfo": _params => ({
      status: 200,
      data: {
        chain: "regtest",
        blocks: 10261,
        headers: 10261,
        bestblockhash: "014b1a0a60452fba0db68a3519921834a6951449f7f6eb739b703178b399dab0",
        difficulty: 4.656542373906925e-10,
        mediantime: 1733970601,
        verificationprogress: 1,
        initialblockdownload: false,
        pruned: false,
      },
    }),

    "/unwatch": address => ({
      status: 200,
      data: {
        event: "unwatch",
        address: address ?? "2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc",
        unconfirmedCallbackURL: null,
        confirmedCallbackURL: null,
      },
    }),

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    "/getbalance": _params => ({
      status: 200,
      data: { balance: 4.72470841 },
    }),

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    "/getnewaddress": _params => ({
      status: 200,
      data: { address: "bcrt1qcjfzjddp27z435e06l2whskqmcntdka6qserej" },
    }),

    "/validateaddress": address => ({
      status: 200,
      data: {
        result: {
          isvalid: true,
          address: address ?? "2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc",
          scriptPubKey: "a914...",
          isscript: true,
          iswitness: false,
        },
        error: null,
        id: null,
      },
    }),
  },

  POST: {
    "/watch": postdata =>
      postdata.address === "-"
        ? {
            status: 400,
            data: { error: { code: -5, message: "Invalid address" } },
          }
        : {
            status: 200,
            data: {
              id: 86,
              event: "watch",
              imported: true,
              inserted: true,
              address: postdata.address ?? "2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc",
              unconfirmedCallbackURL: postdata.unconfirmedCallbackURL ?? null,
              confirmedCallbackURL: postdata.confirmedCallbackURL ?? "https://example.com/confirmed",
              label: postdata.label ?? null,
              eventMessage: postdata.eventMessage ?? null,
            },
          },

    "/unwatch": postdata => ({
      status: 200,
      data: {
        event: "unwatch",
        address: postdata.address ?? "2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc",
        unconfirmedCallbackURL: postdata.unconfirmedCallbackURL ?? null,
        confirmedCallbackURL: postdata.confirmedCallbackURL ?? null,
      },
    }),

    "/watchtxid": postdata => ({
      status: 200,
      data: {
        id: 48,
        event: "watchtxid",
        inserted: true,
        txid: postdata.txid ?? "b081ca7724386f549cf0c16f71db6affeb52ff7a0d9b606fb2e5c43faffd3387",
        confirmedCallbackURL: postdata.confirmedCallbackURL ?? "https://example.com/confirmed",
        xconfCallbackURL: postdata.xconfCallbackURL ?? "https://example.com/xconfirmed",
        nbxconf: postdata.nbxconf ?? 6,
      },
    }),

    "/unwatchtxid": postdata => ({
      status: 200,
      data: {
        event: "unwatchtxid",
        txid: postdata.txid ?? "b081ca7724386f549cf0c16f71db6affeb52ff7a0d9b606fb2e5c43faffd3387",
        confirmedCallbackURL: postdata.confirmedCallbackURL ?? "https://example.com/confirmed",
        xconfCallbackURL: postdata.xconfCallbackURL ?? "https://example.com/xconfirmed",
      },
    }),

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    "/getnewaddress": _params => ({
      status: 200,
      data: { address: "bcrt1qcjfzjddp27z435e06l2whskqmcntdka6qserej" },
    }),

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    "/addtobatch": _postdata => ({
      status: 200,
      data: {
        result: {
          batcherId: 1,
          outputId: 87,
          nbOutputs: 1,
          oldest: "2024-12-17 03:56:22.66268",
          total: 0.001,
        },
        error: null,
      },
    }),

    "/removefrombatch": postdata => ({
      status: 200,
      data: {
        result: {
          batcherId: 1,
          outputId: postdata.outputId ?? 87,
          nbOutputs: 1,
          oldest: "2024-12-17 03:56:22.66268",
          total: 0.001,
        },
        error: null,
      },
    }),

    "/getbatchdetails": postdata => ({
      status: 200,
      data: {
        result: {
          batcherId: postdata.batcherId ?? 1,
          batcherLabel: "default",
          confTarget: 6,
          nbOutputs: 2,
          oldest: "2024-12-17 03:56:22.66268",
          total: 0.0026,
          txid: null,
          hash: null,
          outputs: [],
        },
        error: null,
      },
    }),

    "/batchspend": postdata => ({
      status: 200,
      data: {
        result: {
          batcherId: postdata.batcherId ?? 1,
          confTarget: postdata.confTarget ?? 6,
          nbOutputs: 1,
          oldest: "2024-12-17 03:56:22.66268",
          total: 0.00005,
          status: "accepted",
          txid: "da0b57cd04c43e6ee28cf33841415406b5bc51dfa7451e85e3a0521d84987d46",
          hash: "18f42c09c4de29c8bae429982a7e09ad14ccf3a4832e3bc5030338f66a66a17f",
          details: { firstseen: 1734409868, size: 814, vsize: 412, replaceable: true, fee: 0.00008307 },
          outputs: [],
        },
        error: null,
      },
    }),

    "/spend": postdata =>
      postdata.address === "invalid"
        ? {
            status: 400,
            data: { message: "Invalid Bitcoin address: invalid" },
          }
        : {
            status: 200,
            data: {
              status: "accepted",
              txid: "f959f4ecc6ea0cdbed4af91d6609ab30d0b351c8c5a29529231679cbc68c7b7e",
              hash: "fedd24e8374ea5ecc69a674fc8de620848aaaf1e5ae975d1bc4cf41aa8871255",
              details: {
                address: postdata.address,
                amount: postdata.amount,
                firstseen: 1734413964,
                size: 370,
                vsize: 208,
                replaceable: true,
                fee: 0.0000416,
              },
            },
          },

    "/createrawtransaction": postdata => {
      const outputs = postdata.outputs ?? {};
      if (Object.keys(outputs).some((addr: string) => addr === "invalid")) {
        return {
          status: 400,
          data: { message: "Invalid Bitcoin address: invalid" },
        };
      }
      return {
        status: 200,
        data: { result: "0200000000...", error: null, id: null },
      };
    },
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cyphernodeClientStub(method: "GET" | "POST", url: string, data: any) {
  let uri: string;
  if (method === "GET") {
    const urlParts = url.split("?");
    uri = urlParts[0];
    if (urlParts.length > 1) {
      data = Object.fromEntries(new URLSearchParams(urlParts[1]));
    }
    const uriParts = (uri.startsWith("/") ? uri.slice(1) : uri).split("/");
    if (uriParts.length > 1) {
      data = uriParts.pop();
      uri = `/${uriParts[0]}`;
    }
  } else {
    uri = url;
  }

  if (CYPHERNODE_STUBS[method][uri]) {
    return CYPHERNODE_STUBS[method][uri](data);
  }

  // Unknown endpoint → 403 (matches the _post 403 / _get 403 tests)
  return { status: 403, data: "Forbidden" };
}
