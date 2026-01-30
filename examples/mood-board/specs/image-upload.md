# Image Upload

## Objective

Allow users to upload images to their mood board for visual reference collection.

## Requirements

- **REQ-1**: Accept jpg, png, webp file formats only
- **REQ-2**: Enforce maximum file size of 10MB
- **REQ-3**: Store files in S3 with unique keys
- **REQ-4**: Generate 200x200 thumbnails for grid display
- **REQ-5**: Require user authentication for uploads

## Constraints

- Uploads must complete within 30 seconds
- Thumbnail generation happens async (don't block upload response)
- S3 bucket is configured via environment variable

## Out of Scope

- Video upload (separate feature)
- Bulk upload UI (v2)
- Image editing/cropping

## Acceptance Criteria

- [ ] User can upload jpg/png/webp files up to 10MB
- [ ] Files over 10MB show clear error message
- [ ] Uploaded images appear in grid within 5 seconds
- [ ] Thumbnails display correctly at 200x200
- [ ] Unauthenticated users see login prompt

## Technical Notes

- Use multer for multipart handling
- Use sharp for thumbnail generation
- S3 key format: `{userId}/{uuid}.{ext}`
