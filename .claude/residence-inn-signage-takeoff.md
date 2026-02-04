# Residence Inn Thousand Oaks - Signage Takeoff Summary

## Project Info
- **Location:** 1872 Newbury Road, Thousand Oaks, CA 91320
- **Client:** Marriott International
- **Documents Analyzed:** `/Users/hamza/Downloads/Residence Inn TO/`

---

## Documents Used

| Document | Purpose |
|----------|---------|
| `01_-_Residence_Inn_Hotel_-_Architectural_-_11-24-2025.pdf` | Primary source - keynotes, elevations, life safety plans |
| `05_-_Residence_Inn_Hotel_-_Electrical_-_Design_Resubmittal_-_11-17-2025.pdf` | Exit sign counts (keynotes 2651, 2652) |
| `09_-_Thousand_Oaks_Res_Inn_-_Interior_Design_-_05-14-2025.pdf` | Interior finish verification |
| `99_-_Thousand_Oaks_Res_Inn_-_Pool_Drawings_-_05-12-2025.pdf` | Pool signage requirements (SP-001) |

---

## Extraction Methodology

### Step 1: Identify Authoritative Sources
- **Room counts:** Used Egress Tables on LS1.01/LS1.02 (not floor plan counting)
  - Floor 1: 34 guestrooms
  - Floor 2: 43 guestrooms
  - Floor 3: 43 guestrooms
  - **Total: 120 guestrooms**

### Step 2: Keynote-Based Counting
Counted actual keynote callouts on drawings, minus the keynote definition itself:

| Keynote | Description | Count Method |
|---------|-------------|--------------|
| 1005 | Building Sign | Count callouts on A3.01 elevations = 4 |
| 1007 | Monument Sign | Count callouts on A0.01 site plan = 1 |
| 1043 | Fire Lane Sign | Count callouts on A0.01 = 4 (minus 1 definition) |
| 2651 | Exit Sign (standard) | Count on E2.01-E2.03 = 4 |
| 2652 | Exit Sign (floor level) | Count on E2.01-E2.03 = 18 |

### Step 3: Code-Required Signs
Applied California Building Code requirements:
- ADA room signs: 1 per guestroom (tactile/braille)
- Stairwell signs: 3 stairwells × 3 floors = 9 signs
- Elevator signs: 1 elevator × 3 floors = 3 signs
- Accessible parking: Per civil drawings
- Pool signs: Per California Health Code (SP-001)

### Step 4: Cross-Reference Verification
- Compared Life Safety plans vs Electrical plans for exit signs
- Used Electrical keynotes as authoritative (avoids double-counting)
- Verified room counts against egress tables (not assumptions)

---

## Scale Conversion (for measuring from drawings)

### Sheet A3.01 - Exterior Elevations
- **Scale:** 3/32" = 1'-0"
- **Multiplier:** 128 (1" on paper = 128" actual)

### At 300 DPI:
```
Actual inches = pixels ÷ 300 × 128
Actual feet = pixels × 0.0356
```

### Example Measurements (Building Signs):
| Description | Pixels | Actual Size |
|-------------|--------|-------------|
| "RESIDENCE INN" main text | 544 × 67 | 19' 4" × 29" |
| "by Marriott" secondary | 205 × 21 | 7' 3" × 9" |

---

## Final Takeoff (216 signs total, 211 in scope)

### Guestroom Signs (120)
```
Category	Description	Qty	Sheet Ref
GUESTROOM SIGNS	Room Number Sign - Floor 1 (Rooms 101-134) - Tactile/Braille	34	Arch LS1.01 Egress Table
GUESTROOM SIGNS	Room Number Sign - Floor 2 (Rooms 201-243) - Tactile/Braille	43	Arch LS1.02 Egress Table
GUESTROOM SIGNS	Room Number Sign - Floor 3 (Rooms 301-343) - Tactile/Braille	43	Arch LS1.02 Egress Table
```

### Exit Signs (22)
```
EXIT SIGNS	Illuminated Exit Sign - Standard (Keynote 2651)	4	Elec E2.01-E2.03
EXIT SIGNS	Illuminated Exit Sign - Floor Level (Keynote 2652)	18	Elec E2.01-E2.03
```

### Stairwell & Elevator Signs (12)
```
STAIRWELL SIGNS	Stair Identification Sign - Stair 1 (Floors 1-3)	3	Arch LS1.01-LS1.02
STAIRWELL SIGNS	Stair Identification Sign - Stair 2 (Floors 1-3)	3	Arch LS1.01-LS1.02
STAIRWELL SIGNS	Stair Identification Sign - Stair 3 (Floors 1-3)	3	Arch LS1.01-LS1.02
ELEVATOR SIGNS	Elevator Floor Identification - Floors 1-3	3	Arch LS1.01-LS1.02
```

### Common Area Signs (13)
```
COMMON AREAS	Lobby Sign - Tactile/Braille	1	Arch LS1.01
COMMON AREAS	Front Desk Sign	1	Arch LS1.01
COMMON AREAS	Breakfast Area Sign	1	Arch LS1.01
COMMON AREAS	Fitness Center Sign - Tactile/Braille	1	Arch LS1.01
COMMON AREAS	Business Center Sign	1	Arch LS1.01
COMMON AREAS	Meeting Room Sign - Tactile/Braille	1	Arch LS1.01
COMMON AREAS	Laundry Room Sign - Tactile/Braille	1	Arch LS1.01
COMMON AREAS	Vending Area Sign	1	Arch LS1.01
COMMON AREAS	Electrical Room Sign	1	Arch LS1.01
COMMON AREAS	Mechanical Room Sign	1	Arch LS1.01
COMMON AREAS	Housekeeping/Linen Sign	1	Arch LS1.01
COMMON AREAS	Manager Office Sign	1	Arch LS1.01
COMMON AREAS	Employee Break Room Sign	1	Arch LS1.01
```

### Restroom Signs (8)
```
RESTROOM SIGNS	Public Restroom - Men (Main Building)	1	Arch A1.01
RESTROOM SIGNS	Public Restroom - Women (Main Building)	1	Arch A1.01
RESTROOM SIGNS	Public Restroom - Men (Pool Building)	1	Pool SP-001
RESTROOM SIGNS	Public Restroom - Women (Pool Building)	1	Pool SP-001
RESTROOM SIGNS	Family/Accessible Restroom	2	Arch A1.01
RESTROOM SIGNS	Employee Restroom	2	Arch A1.01
```

### Pool Signs (24)
```
POOL SIGNS	No Diving Sign	2	Pool SP-001
POOL SIGNS	No Lifeguard on Duty Sign	2	Pool SP-001
POOL SIGNS	Pool Rules Sign	2	Pool SP-001
POOL SIGNS	Pool Capacity Sign	1	Pool SP-001
POOL SIGNS	CPR Instructions Sign	1	Pool SP-001
POOL SIGNS	Emergency Phone/Dial 911 Sign	1	Pool SP-001
POOL SIGNS	Keep Gate Closed Sign	2	Pool SP-001
POOL SIGNS	Shower Before Entering Sign	1	Pool SP-001
POOL SIGNS	No Glass in Pool Area Sign	2	Pool SP-001
POOL SIGNS	Depth Markers (Pool)	6	Pool SP-001
POOL SIGNS	Spa Warning Sign - CAUTION	1	Pool SP-001
POOL SIGNS	Spa Capacity Sign	1	Pool SP-001
POOL SIGNS	Emergency Shut-Off Sign (Spa)	1	Pool SP-001
POOL SIGNS	Chemical Storage/Hazmat Sign	1	Pool SP-001
```

### Parking & Wayfinding (8)
```
PARKING SIGNS	Accessible Parking Sign w/ Van Accessible	4	Civil/Arch A0.01
PARKING SIGNS	EV Charging Station Sign	2	Civil
PARKING SIGNS	Guest Parking Sign	1	Arch A0.01
PARKING SIGNS	Employee Parking Sign	1	Arch A0.01
```

### Fire & Life Safety (4)
```
FIRE/LIFE SAFETY	Fire Lane - No Parking Sign (Keynote 1043)	4	Arch A0.01
```

### Exterior - NIC (5)
```
EXTERIOR - NIC	Building Sign (Keynote 1005) - By Signage Consultant	4	Arch A3.01
EXTERIOR - NIC	Monument Sign (Keynote 1007) - By Signage Consultant	1	Arch A0.01
```

---

## Building Signs Detail (NIC but likely in scope)

### Locations (4 total - one per elevation):
1. **West Elevation** - Center tower, above 3rd floor
2. **South Elevation** - Center tower, above 3rd floor
3. **East Elevation** - Center tower, above 3rd floor
4. **North Elevation** - Center tower, above 3rd floor

### Measured Dimensions (from A3.01 at 300 DPI):
- **"RESIDENCE INN":** ~19' 4" wide × 29" tall letters
- **"by Marriott":** ~7' 3" wide × 9" tall letters

### Construction (typical Marriott spec):
- **Type:** Halo-lit (reverse channel) letters
- **Face:** .090" aluminum
- **Returns:** .063" aluminum, 3-4" depth
- **Back:** Clear polycarbonate
- **Illumination:** LED (white)
- **Standoff:** 1.5-2" from wall
- **Finish:** Powder coat to Marriott PMS spec

### Monument Sign:
- **Location:** Site entrance from Newbury Road (see A0.01, keynote 1007)
- **Dimensions:** Not shown - requires signage consultant drawings
- **Type:** Internally illuminated cabinet (typical)

---

## Key Notes

1. **Exterior signage note (CS.0-0):** "ALL EXTERIOR BUILDING SIGNAGE AND SITE SIGNAGE TO BE PROCESSED UNDER SEPARATE REVIEW & APPROVAL" - This refers to permitting, not exclusion from scope.

2. **Keynotes 1005/1007** say "REFER TO SIGNAGE CONSULTANT DRAWINGS" - these drawings are not included in the bid package.

3. **Accessible rooms (12):** Already included in 120 guestroom count. ISA symbol added to those signs, not separate signs.

4. **Exit signs:** Use Electrical plans (keynotes 2651/2652), not Life Safety plans to avoid double-counting.

---

## Errors Corrected During Takeoff

| Original Assumption | Corrected To | Reason |
|---------------------|--------------|--------|
| 6 building signs | 4 | Only 4 keynote 1005 callouts on elevations |
| 45+ exit signs | 22 | Used Electrical keynotes, not Life Safety |
| Porte cochere sign | Removed | No keynote 1005 on canopy |
| South elevation wing signs | Removed | Only center tower has sign |
| Pavement markings as signs | Removed | Striping is not signage |

---

## For Marriott Sign Specs

Brand standards not publicly available. Contact:
- **HOTELSIGNS.com:** 1-888-273-8726
- **ADAHotelSigns.com:** 800-742-5507, residenceinn@adahotelsigns.com
- **RFI to GC** for signage consultant drawings
