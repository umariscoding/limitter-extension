#!/usr/bin/env python3
"""
Simple script to create basic PNG icons for the Chrome extension.
"""

from PIL import Image, ImageDraw, ImageFont
import os

def create_icon(size, filename):
    """Create a simple icon with the given size."""
    # Create a new image with RGBA mode (with transparency)
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Draw a gradient-like background circle
    center = size // 2
    radius = int(size * 0.45)
    
    # Draw background circle
    draw.ellipse(
        [center - radius, center - radius, center + radius, center + radius],
        fill=(102, 126, 234, 255),  # Blue color
        outline=(255, 255, 255, 255),
        width=max(1, size // 32)
    )
    
    # Draw prohibition sign (red circle with diagonal line)
    prohibition_radius = int(size * 0.35)
    draw.ellipse(
        [center - prohibition_radius, center - prohibition_radius, 
         center + prohibition_radius, center + prohibition_radius],
        fill=None,
        outline=(255, 68, 68, 255),  # Red color
        width=max(2, size // 16)
    )
    
    # Draw diagonal line
    line_start = int(size * 0.25)
    line_end = int(size * 0.75)
    draw.line(
        [line_start, line_start, line_end, line_end],
        fill=(255, 68, 68, 255),
        width=max(2, size // 16)
    )
    
    # Try to add text "YT" if size is large enough
    if size >= 32:
        try:
            # Use default font
            font_size = max(8, size // 6)
            font = ImageFont.load_default()
            
            # Calculate text position
            text = "YT"
            bbox = draw.textbbox((0, 0), text, font=font)
            text_width = bbox[2] - bbox[0]
            text_height = bbox[3] - bbox[1]
            
            text_x = center - text_width // 2
            text_y = center - text_height // 2
            
            draw.text((text_x, text_y), text, fill=(255, 255, 255, 255), font=font)
        except:
            # If font loading fails, just skip text
            pass
    
    # Save the image
    img.save(filename, 'PNG')
    print(f"Created {filename} ({size}x{size})")

def main():
    # Create icons directory if it doesn't exist
    if not os.path.exists('icons'):
        os.makedirs('icons')
    
    # Create different sized icons
    sizes = [16, 32, 48, 128]
    
    for size in sizes:
        filename = f'icons/icon{size}.png'
        create_icon(size, filename)
    
    print("All icons created successfully!")

if __name__ == '__main__':
    main() 