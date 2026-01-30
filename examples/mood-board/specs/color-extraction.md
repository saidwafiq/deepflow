# Color Extraction

## Objective

Automatically extract dominant colors from uploaded images to help designers identify color palettes.

## Requirements

- **REQ-1**: Extract 5 dominant colors from each image
- **REQ-2**: Display colors as clickable swatches
- **REQ-3**: Copy hex code to clipboard on click

## Constraints

- Extraction must complete within 2 seconds per image
- Colors stored with image metadata (don't re-extract)

## Out of Scope

- Custom palette creation
- Color harmony suggestions (v2)
- Export to design tools

## Acceptance Criteria

- [ ] Each uploaded image shows 5 color swatches
- [ ] Clicking swatch copies hex code
- [ ] Toast confirms "Copied #RRGGBB"

## Technical Notes

- Use color-thief library for extraction
- Run extraction after thumbnail generation
- Store colors as JSON array in image record
