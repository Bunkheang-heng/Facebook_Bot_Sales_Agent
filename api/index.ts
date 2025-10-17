export default function handler(_req: any, res: any) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Messenger bot is running');
}


