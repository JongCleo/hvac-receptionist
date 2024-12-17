import Retell from 'retell-sdk';

let retellClient: Retell;

if (process.env.NODE_ENV === 'production') {
  retellClient = new Retell({
    apiKey: process.env.RETELL_API_KEY || '',
  });
} else {
  if (!(global as any).retell) {
    (global as any).retell = new Retell({
      apiKey: process.env.RETELL_API_KEY || '',
    });
  }
  retellClient = (global as any).retell;
}

export default retellClient;
