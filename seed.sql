-- NCPA Crew Data - Seeded from capability matrix

-- Clear existing data
DELETE FROM assignments;
DELETE FROM events;
DELETE FROM crew_unavailability;
DELETE FROM workload_history;
DELETE FROM crew;

-- Senior Crew
INSERT INTO crew (name, level, can_stage, stage_only_if_urgent, is_outside_crew, venue_capabilities, vertical_capabilities, special_notes) VALUES
('Naren', 'Senior', 1, 1, 0, 
 '{"JBT": "Y", "Tata": "Y", "Experimental": "Y", "Little Theatre": "N", "Godrej Dance": "N", "Others": "Y"}',
 '{"Indian Music": "Y", "Intl Music": "Y*", "Western Music": "Y", "Theatre": "Y", "Corporate": "Y", "Library": "Y", "Dance": "Y", "Others": "Y"}',
 'Special: Intl Music FOH');

INSERT INTO crew (name, level, can_stage, stage_only_if_urgent, is_outside_crew, venue_capabilities, vertical_capabilities, special_notes) VALUES
('Nikhil', 'Senior', 1, 1, 0,
 '{"JBT": "Y*", "Tata": "Y*", "Experimental": "Y*", "Little Theatre": "Y", "Godrej Dance": "Y", "Others": "Y"}',
 '{"Indian Music": "Y", "Intl Music": "Y*", "Western Music": "Y", "Theatre": "Y", "Corporate": "Y", "Library": "Y", "Dance": "Y", "Others": "Y"}',
 'Best for JBT/Tata/Exp. Special: Intl Music');

INSERT INTO crew (name, level, can_stage, stage_only_if_urgent, is_outside_crew, venue_capabilities, vertical_capabilities, special_notes) VALUES
('Coni', 'Senior', 1, 0, 0,
 '{"JBT": "Y", "Tata": "Y", "Experimental": "Y", "Little Theatre": "Y", "Godrej Dance": "Y", "Others": "Y"}',
 '{"Indian Music": "Y", "Intl Music": "N", "Western Music": "Y", "Theatre": "Y", "Corporate": "Y", "Library": "Y", "Dance": "Y", "Others": "Y"}',
 'Cannot FOH Intl Music');

INSERT INTO crew (name, level, can_stage, stage_only_if_urgent, is_outside_crew, venue_capabilities, vertical_capabilities, special_notes) VALUES
('Sandeep', 'Senior', 1, 0, 0,
 '{"JBT": "N", "Tata": "N", "Experimental": "Y", "Little Theatre": "Y", "Godrej Dance": "Y", "Others": "Y"}',
 '{"Indian Music": "Y", "Intl Music": "N", "Western Music": "Y", "Theatre": "Y", "Corporate": "Y", "Library": "Y", "Dance": "Y", "Others": "Y"}',
 'Cannot FOH Intl Music');

-- Mid Level Crew
INSERT INTO crew (name, level, can_stage, stage_only_if_urgent, is_outside_crew, venue_capabilities, vertical_capabilities, special_notes) VALUES
('Aditya', 'Mid', 1, 0, 0,
 '{"JBT": "Y", "Tata": "Y", "Experimental": "Y", "Little Theatre": "Y", "Godrej Dance": "Y", "Others": "Y"}',
 '{"Indian Music": "Y*", "Intl Music": "N", "Western Music": "Y*", "Theatre": "Y", "Corporate": "Y", "Library": "Y", "Dance": "Y", "Others": "Y"}',
 'Special: Indian/Western Music. No Intl');

INSERT INTO crew (name, level, can_stage, stage_only_if_urgent, is_outside_crew, venue_capabilities, vertical_capabilities, special_notes) VALUES
('Viraj', 'Mid', 1, 0, 0,
 '{"JBT": "N", "Tata": "N", "Experimental": "Y", "Little Theatre": "Y", "Godrej Dance": "Y", "Others": "Y"}',
 '{"Indian Music": "Y", "Intl Music": "N", "Western Music": "N", "Theatre": "Y", "Corporate": "Y", "Library": "Y", "Dance": "Y", "Others": "Y"}',
 'Cannot FOH Intl or Western');

INSERT INTO crew (name, level, can_stage, stage_only_if_urgent, is_outside_crew, venue_capabilities, vertical_capabilities, special_notes) VALUES
('NS', 'Mid', 1, 0, 0,
 '{"JBT": "Y", "Tata": "Y", "Experimental": "Y", "Little Theatre": "Y", "Godrej Dance": "Y", "Others": "Y"}',
 '{"Indian Music": "Y", "Intl Music": "Y*", "Western Music": "Y", "Theatre": "Y", "Corporate": "Y", "Library": "Y", "Dance": "Y", "Others": "Y"}',
 'Most flexible. Special: Intl Music');

INSERT INTO crew (name, level, can_stage, stage_only_if_urgent, is_outside_crew, venue_capabilities, vertical_capabilities, special_notes) VALUES
('Nazar', 'Mid', 1, 0, 0,
 '{"JBT": "N", "Tata": "N", "Experimental": "Y", "Little Theatre": "Y", "Godrej Dance": "Y", "Others": "Y"}',
 '{"Indian Music": "Y", "Intl Music": "Exp only", "Western Music": "Y", "Theatre": "Y", "Corporate": "Y", "Library": "Y", "Dance": "Y", "Others": "Y"}',
 'Intl Music FOH ONLY at Experimental');

INSERT INTO crew (name, level, can_stage, stage_only_if_urgent, is_outside_crew, venue_capabilities, vertical_capabilities, special_notes) VALUES
('Shridhar', 'Mid', 1, 0, 0,
 '{"JBT": "N", "Tata": "N", "Experimental": "Y", "Little Theatre": "Y", "Godrej Dance": "Y", "Others": "Y"}',
 '{"Indian Music": "Y", "Intl Music": "N", "Western Music": "Y", "Theatre": "Y", "Corporate": "Y", "Library": "Y", "Dance": "Y", "Others": "Y"}',
 'Not JBT/Tata. No Intl Music FOH');

-- Junior Crew
INSERT INTO crew (name, level, can_stage, stage_only_if_urgent, is_outside_crew, venue_capabilities, vertical_capabilities, special_notes) VALUES
('Omkar', 'Junior', 1, 0, 0,
 '{"JBT": "N", "Tata": "N", "Experimental": "N", "Little Theatre": "Y", "Godrej Dance": "Y", "Others": "Y"}',
 '{"Indian Music": "Y", "Intl Music": "N", "Western Music": "Y", "Theatre": "Y", "Corporate": "Y", "Library": "Y", "Dance": "Y", "Others": "Y"}',
 'Junior. No Intl Music FOH');

INSERT INTO crew (name, level, can_stage, stage_only_if_urgent, is_outside_crew, venue_capabilities, vertical_capabilities, special_notes) VALUES
('Akshay', 'Junior', 1, 0, 0,
 '{"JBT": "N", "Tata": "N", "Experimental": "Y", "Little Theatre": "Y", "Godrej Dance": "Y", "Others": "Y"}',
 '{"Indian Music": "Y", "Intl Music": "N", "Western Music": "Y", "Theatre": "Y", "Corporate": "Y", "Library": "Y", "Dance": "Y", "Others": "Y"}',
 'Junior. No Intl Music FOH');

-- Outside/Hired Crew
INSERT INTO crew (name, level, can_stage, stage_only_if_urgent, is_outside_crew, venue_capabilities, vertical_capabilities, special_notes) VALUES
('OC1', 'Hired', 1, 0, 1,
 '{"JBT": "N", "Tata": "N", "Experimental": "N", "Little Theatre": "N", "Godrej Dance": "N", "Others": "N"}',
 '{"Indian Music": "Y", "Intl Music": "Y", "Western Music": "Y", "Theatre": "Y", "Corporate": "Y", "Library": "Y", "Dance": "Y", "Others": "Y"}',
 'Outside Crew. Stage only. Use when internal unavailable');

INSERT INTO crew (name, level, can_stage, stage_only_if_urgent, is_outside_crew, venue_capabilities, vertical_capabilities, special_notes) VALUES
('OC2', 'Hired', 1, 0, 1,
 '{"JBT": "N", "Tata": "N", "Experimental": "N", "Little Theatre": "N", "Godrej Dance": "N", "Others": "N"}',
 '{"Indian Music": "Y", "Intl Music": "Y", "Western Music": "Y", "Theatre": "Y", "Corporate": "Y", "Library": "Y", "Dance": "Y", "Others": "Y"}',
 'Outside Crew. Stage only. Use when internal unavailable');

INSERT INTO crew (name, level, can_stage, stage_only_if_urgent, is_outside_crew, venue_capabilities, vertical_capabilities, special_notes) VALUES
('OC3', 'Hired', 1, 0, 1,
 '{"JBT": "N", "Tata": "N", "Experimental": "N", "Little Theatre": "N", "Godrej Dance": "N", "Others": "N"}',
 '{"Indian Music": "Y", "Intl Music": "Y", "Western Music": "Y", "Theatre": "Y", "Corporate": "Y", "Library": "Y", "Dance": "Y", "Others": "Y"}',
 'Outside Crew. Stage only. Use when internal unavailable');
