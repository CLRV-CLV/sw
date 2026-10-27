// Local SMTP sink for protocol tests only; never used by production mail delivery.
import net from "node:net";
import { once } from "node:events";
export async function createSmtpSink() {
  const messages = [];
  const smtp = net.createServer((socket) => {
    socket.write("220 localhost ESMTP test\r\n");
    let buffer = "",
      data = null,
      to = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data !== null) {
          if (line === ".") {
            const raw = data.join("\r\n"),
              parts = raw.split("\r\n\r\n"),
              body = parts.slice(1).join("\r\n\r\n");
            const text = /content-transfer-encoding: base64/i.test(parts[0])
              ? Buffer.from(body, "base64").toString()
              : body.replace(/=\r\n/g, "");
            messages.push({ to, code: text.match(/\b\d{6}\b/)?.[0], raw });
            data = null;
            socket.write("250 accepted\r\n");
          } else data.push(line);
          continue;
        }
        if (/^EHLO|^HELO/.test(line))
          socket.write("250-localhost\r\n250 PIPELINING\r\n");
        else if (/^MAIL FROM:/.test(line)) socket.write("250 sender ok\r\n");
        else if (/^RCPT TO:/.test(line)) {
          to = line.match(/<([^>]+)>/)?.[1];
          socket.write("250 recipient ok\r\n");
        } else if (line === "DATA") {
          data = [];
          socket.write("354 send message\r\n");
        } else if (line === "QUIT") {
          socket.end("221 bye\r\n");
        } else socket.write("250 ok\r\n");
      }
    });
  });
  smtp.listen(0, "127.0.0.1");
  await once(smtp, "listening");
  return { server: smtp, messages };
}
