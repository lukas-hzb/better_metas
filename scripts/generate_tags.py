#!/usr/bin/env python3
"""
Generate tags for all metas in plonkit_metas.json.

Available tags:
- plants: vegetation, trees, forests, grass, etc.
- bollards: road bollards, delineators
- poles: utility poles, lamp posts, power lines
- signs: road signs, street signs, directional signs
- language: script, alphabet, language features
- license plates: license plates, vehicle plates
- cars: coverage vehicle, google car, pickup truck
- architecture: buildings, houses, construction style
- soil: ground, floor, terrain, road surface
- camera: camera types, quality, generation, dirt/smudges on lens, camera angles/tilt
- structures: silos, water towers, strange buildings, non-architecture landmarks
"""

import json
import re
from pathlib import Path

JSON_FILE_PATH = Path(__file__).parent.parent / "data" / "plonkit_metas.json"

# Tag detection patterns
TAG_PATTERNS = {
    "plants": [
        r"\b(tree|trees|forest|vegetation|grass|grassy|shrub|shrubbery|bush|bushes)\b",
        r"\b(palm|pine|birch|spruce|acacia|eucalyptus|bamboo|cactus|cacti)\b",
        r"\b(farmland|agricultural|crop|crops|field|fields|vineyard|orchard)\b",
        r"\b(green|lush|vegetated|forested|jungle|rainforest)\b",
        r"\b(flower|flowers|plant|plants|garden)\b",
    ],
    "bollards": [
        r"\b(bollard|bollards|delineator|delineators)\b",
        r"\b(road\s+marker|post\s+marker)\b",
        r"\b(kilometer\s+marker|km\s+marker|mile\s+marker)\b",
        r"\b(reflector\s+post|guide\s+post)\b",
    ],
    "poles": [
        r"\b(pole|poles)\b",
        r"\b(lamp\s*post|lamppost|street\s+lamp|street\s+light)\b",
        r"\b(power\s+line|power\s+lines|electric\s+line)\b",
        r"\b(utility\s+pole|telegraph\s+pole|telephone\s+pole)\b",
        r"\b(insulator|insulators)\b",
        r"\b(wooden\s+pole|concrete\s+pole|metal\s+pole)\b",
    ],
    "signs": [
        r"\b(sign|signs|signpost|signage)\b",
        r"\b(street\s+sign|road\s+sign|directional\s+sign)\b",
        r"\b(speed\s+limit|stop\s+sign|yield\s+sign)\b",
        r"\b(billboard|placard|notice)\b",
        r"\b(chevron|chevrons)\b",
        r"\b(warning\s+sign|information\s+sign)\b",
    ],
    "language": [
        r"\b(language|alphabet|script)\b",
        r"\b(cyrillic|latin|arabic|devanagari|thai|chinese|japanese|korean|hebrew)\b",
        r"\b(writing|written|text|letter|letters)\b",
        r"\b(bilingual|multilingual|dual\s+script)\b",
        r"\b(english|french|spanish|german|russian|portuguese)\b",
    ],
    "plates": [
        r"\b(licence\s+plate|license\s+plate|number\s+plate)\b",
        r"\b(plate|plates)\b(?!.*tectonic)",  # Avoid "tectonic plates"
        r"\b(vehicle\s+registration|car\s+registration)\b",
        r"\b(yellow\s+plate|white\s+plate|blue\s+plate|red\s+plate)\b",
    ],
    "cars": [
        r"\b(pickup\s+truck|pickup)\b",
        r"\b(google\s+car|street\s+view\s+car|coverage\s+car|car\s+blur)\b",
        r"\b(antenna|antennae)\b",
        r"\b(car\s+meta|vehicle\s+meta|car\s+feature)\b",
        r"\b(follow\s+car|chase\s+car|trekker|shampoo)\b",
        r"\b(white\s+car|black\s+car|silver\s+car|white\s+pickup)\b",
        r"\b(4x4|suv|jeep|motorcycle|motorbike|scooter|moped|tuk\s*tuk|rickshaw)\b",
        r"\b(roof\s+rack|rack|bars|ladder)\b",
    ],
    "architecture": [
        r"\b(building|buildings|house|houses|home|homes)\b",
        r"\b(architecture|architectural)\b",
        r"\b(stone|brick|concrete|wooden)\s+(building|house|structure)\b",
        r"\b(roof|roofs|rooftop)\b",
        r"\b(tower|towers|church|mosque|temple|cathedral)\b",
        r"\b(colonial|modern|traditional|historic)\b",
        r"\b(fence|fences|wall|walls|gate|gates)\b",
        r"\b(style|styles)\b.*\b(building|house|architecture)\b",
    ],
    "soil": [
        # Physical dirt on surfaces (Ground/Floor)
        r"\b(soil|terrain|ground|floor)\b",
        r"\b(dirt|dirty|dust|dusty|mud|muddy|grime|grimy)\b(?!(.*\b(camera|lens)\b))",
        r"\b(roof\s+dust|dirty\s+roof|dusty\s+roof|dirt\s+on\s+roof)\b",
        r"\b(dirt\s+road|dirt\s+track)\b",
        r"\b(muddy|dusty|sandy|rocky)\s+road\b",
        r"\b(splatter|splash|splashed)\b",
    ],
    "road": [
        r"\b(road|roads|highway|highways|motorway)\b",
        r"\b(pavement|asphalt|tarmac|gravel|unpaved|paved)\b",
        r"\b(road\s+line|road\s+lines|center\s+line|outer\s+line|yellow\s+line|white\s+line)\b",
        r"\b(lane|lanes|shoulder|median|divider)\b",
        r"\b(intersection|junction|roundabout)\b",
        r"\b(bridge|tunnel|overpass|underpass)\b",
        r"\b(curb|curbs|kerb|kerbs|sidewalk|pavement)\b",
        r"\b(guardrail|guardrails|barrier|barriers)\b",
        r"\b(divided\s+highway|dual\s+carriageway)\b",
    ],
    "camera": [
        # Art / Type / Generation
        r"\b(camera|cameras|smallcam|lowcam|shitcam|dashcam)\b",
        # Generation (only if not about vehicle specifically)
        r"\b(gen(?:eration)?\s*[1-4])\b(?!.*\b(motorcycle|motorbike|scooter|car|pickup)\b)",
        r"\b(gen(?:eration)?\s*[1-4]|shitcam|smallcam|lowcam)\s+coverage",
        r"\b(copyright|watermark)\b",
        r"\b(panorama|360|fisheye)\b",
        r"\b(tripod|mounted)\b",
        
        # Qualität / Quality / Effects
        r"\b(quality|resolution|low\s+quality|high\s+quality)\b",
        r"\b(grainy|sharp|overexposed|underexposed)\b",
        r"\b(glare|flare|halo|reflection)\b",
        r"\b(exposure|haze|hazy|foggy)\b", 
        
        # Blur (only image/lens blur)
        # Avoid variable width lookahead/behind for Python re
        r"\b(blur|blurred|unblurred)\b",
        
        # Schmutz / Dirt on camera (user specified schmutz der kamera)
        r"\b(smudge|smear|stain|smudges|smears|stains)\b",
        r"\b(dust\s+on\s+camera|dirt\s+on\s+camera|dirty\s+camera|smudge\s+on\s+camera)\b",
        r"\b(droplet|water\s+on\s+camera)\b",
        
        # Winkel / Angle
        r"\b(camera\s+angle|camera\s+tilt|camera\s+orientation|camera\s+height|camera\s+position)\b",
        r"\b(tilted|angled)\s+camera\b",
        r"\b(fisheye|wide\s+angle)\b",
    ],
    "structures": [
        r"\b(silo|silos)\b",
        r"\b(water\s+tower|water\s+towers)\b",
        r"\b(strange\s+house|strange\s+building|strange\s+architecture)\b",
        r"\b(hut|huts|shack|shacks|cabin|cabins)\b",
        r"\b(monument|statue|sculpture)\b",
        r"\b(lighthouse|lighthouses)\b",
        r"\b(hangar|hangars|warehouse|warehouses)\b",
    ],
}


def determine_tags(title: str, desc: str, note: str) -> list:
    """Determine tags for a meta based on its content."""
    all_text = f"{title} {desc} {note}".lower()
    tags = []
    
    # Pre-check for exclusions to handle the "blur" cases better without complex regex
    is_vehicle_blur = re.search(r"\b(car|roof|motorbike|motorcycle|scooter)\b.*\b(blur|blurred|unblurred)\b", all_text) or \
                      re.search(r"\b(blur|blurred|unblurred)\b.*\b(car|roof|motorbike|motorcycle|scooter)\b", all_text)

    for tag, patterns in TAG_PATTERNS.items():
        for pattern in patterns:
            if re.search(pattern, all_text, re.I):
                # Manual exclusion for blur if it's about a vehicle
                if tag == "camera" and "blur" in pattern and is_vehicle_blur:
                    continue
                
                if tag not in tags:
                    tags.append(tag)
                break  # Found match for this tag, move to next
    
    return tags


def main():
    print("Loading plonkit_metas.json...")
    with open(JSON_FILE_PATH, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    stats = {tag: 0 for tag in TAG_PATTERNS.keys()}
    stats["(none)"] = 0
    
    count = 0
    for country_data in data:
        country_name = country_data.get('country', 'Unknown')
        for meta in country_data.get('metas', []):
            title = meta.get('title', '')
            desc = meta.get('description', '')
            note = meta.get('note', '')
            
            new_tags = determine_tags(title, desc, note)
            meta['tags'] = new_tags
            
            if new_tags:
                for tag in new_tags:
                    stats[tag] += 1
            else:
                stats["(none)"] += 1
            
            count += 1
            
            # Show first few examples
            if count <= 20 and new_tags:
                print(f"[{country_name}] {', '.join(new_tags):30} | {title[:40]}")
    
    print(f"\n{'='*50}")
    print("TAG DISTRIBUTION:")
    print('='*50)
    for tag, num in sorted(stats.items(), key=lambda x: -x[1]):
        print(f"  {tag:15}: {num:5} metas")
    print(f"{'='*50}")
    print(f"Total: {count} metas processed\n")
    
    print("Saving to plonkit_metas.json...")
    with open(JSON_FILE_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    
    print("Done!")


if __name__ == "__main__":
    main()
