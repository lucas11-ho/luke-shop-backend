# Technical Analysis v0.8.0

Uploaded media is stored as tenant/store-scoped assets. Local storage is the initial adapter; storage keys are generated, not supplied by users. The upload API accepts allowlisted image/video MIME types, validates basic file signatures, enforces configured size limits, hashes content with SHA-256, and excludes SVG/HTML. Product media references an asset while retaining the established public URL/private storage-key contract.
