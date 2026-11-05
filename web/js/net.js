// The machine's network card: virtio-net, ending in v86's fetch adapter.
// The guest has 192.168.86.100/24 (kernel ip= on the command line), the
// adapter plays the router 192.168.86.1 and its DNS; every HTTP request on
// port 80 becomes a fetch() from the page (HTTPS when the page is HTTPS),
// so what a site answers is subject to CORS. Shared by the page and the
// Node harness: a saved machine only restores with the same devices.
export const NET_DEVICE = Object.freeze({
  type: "virtio",
  relay_url: "fetch",
  router_ip: "192.168.86.1",
  vm_ip: "192.168.86.100",
});

export const netDevice = () => ({ ...NET_DEVICE });
