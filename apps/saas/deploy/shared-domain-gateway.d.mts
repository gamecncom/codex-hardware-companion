export function createGateway(options?: {
  listenHost?: string; listenPort?: number | false;
  hcHost?: string; hcPort?: number; bookHost?: string; bookPort?: number;
}): import('node:http').Server;
