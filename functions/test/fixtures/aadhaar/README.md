Aadhaar Secure QR test fixtures (dummy people, no real Aadhaar data):

- uidai-sample-v1.txt: UIDAI's published sample card ("Penumarthi Venkat"), old format, via
  github.com/vishaltanwar96/aadhaar-py (MIT). Its signing key is UIDAI's test key, so it
  must NOT verify against the production certificates.
- test-signed-v2.txt + test-certificate.pem: a V2 QR signed with a published test key, via
  github.com/anon-aadhaar/anon-aadhaar (MIT). Used to prove the signature check itself.
