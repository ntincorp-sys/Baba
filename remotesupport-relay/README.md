# RemoteSupport relay server

Lets the RemoteSupport phone app be watched and controlled from anywhere.
The phone connects **out** to this server, so it works on mobile data and behind any router.
The technician opens the server's web page, types the phone's Device ID and PIN, and gets the live screen.

## Deploy free on Render (about 10 minutes)

1. This folder lives in the `remotesupport-relay/` folder of the `ntincorp-sys/Baba` repository.
2. Sign in at https://render.com with GitHub, then **New + → Web Service** and pick the repo.
3. Settings:
   - Root Directory: `remotesupport-relay`
   - Runtime: Node · Build command: `npm install --omit=dev` · Start command: `node server.js`
   - Instance type: Free
4. Click **Create Web Service**. When it says *Live*, copy the address, e.g. `https://remotesupport-relay.onrender.com`.
5. In the phone app, paste that address under **Connect from anywhere** and tap **Save**.

The free plan sleeps after ~15 minutes without traffic. The phone's first connection then takes
up to a minute while it wakes; the app keeps retrying on its own. A paid instance ($7/month) stays awake.

Other hosts work the same way: Railway, Fly.io, or any VPS with Node 18+
behind HTTPS (Caddy or nginx). Always use **https** so traffic is encrypted in transit.

## Run locally

```
npm install
npm start          # http://localhost:8080
npm test           # end-to-end check with a fake phone and viewer
```

## Security notes

- Each phone has a permanent 9-digit Device ID and a new 6-digit PIN every session.
- 5 wrong PINs lock viewer access to that phone for 10 minutes (the phone shows an alert);
  each IP is also limited to 20 connection attempts per minute.
- At most 3 viewers per phone. Control only works while the phone is sharing and Accessibility is on.
- Traffic is TLS-encrypted between each side and the server, but the server itself can see the frames.
  Host it yourself; true end-to-end encryption is Phase 4 of the design doc.
