document.addEventListener('DOMContentLoaded', () => {
    // --- USER PREFERENCE: Unlink on manual move toggle ---
    const unlinkToggle = document.getElementById('unlink-on-manual-move');

    // --- CONTEXT-INDEPENDENT UUID GENERATOR ---
    function generateUUID() {
        // A robust fallback that does not rely on the crypto library.
        let
            d = new Date().getTime(),
            d2 = (performance && performance.now && (performance.now() * 1000)) || 0;
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            let r = Math.random() * 16;
            if (d > 0) {
                r = (d + r) % 16 | 0;
                d = Math.floor(d / 16);
            } else {
                r = (d2 + r) % 16 | 0;
                d2 = Math.floor(d2 / 16);
            }
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    // --- GLOBAL STATE & CONFIGURATION ---
    let masterTaskList = [];
    let episodesData = [];
    let budgetData = {};
    let overallMinDate, overallMaxDate;
    let enforceSequentialLock = true;
    let scheduleType = 'hour-long';
    let currentView = 'timeline';
    let debounceTimer;
    let viewState = { timeline: 'fresh', waterfall: 'stale', grid: 'fresh', budget: 'stale' };
    let hiatuses = [];
    let sixthDayWorkDates = [];
    let gridVisibleColumns = null;
    const allGridColumns = ['Block', 'Director', 'Editor', 'Shoot Dates', "Editor's Cut", "Director's Cut", "Producer's Cut", 'Lock', 'Color', 'Final Mix', 'QC Delivery', 'Final Delivery', 'Earliest Release'];

    const taskColors = {
        "SHOOT": "#6c757d", "Editor's Cut": "#2a9d8f", "Director's Cut": "#e9c46a", "Producer Notes": "#a8dadc",
        "Director's Cut v2": "#e9c46a", "Producer's Cut": "#f4a261", "Notes": "#adb5bd", "Studio/Network Cut": "#264653",
        "Picture Lock": "#e76f51", "Turnovers": "#4cc9f0", "MUSIC": "#b5179e", "VFX Due": "#f72585",
        "Online Conform": "#8ECAE6", "Color Grade": "#219EBC", "Color Review": "#126782", "Final Color Grade": "#023047",
        "Pre-Mix": "#D4E09B", "Final Mix": "#90A959", "Mix Review": "#6A994E", "Final Mix Fix": "#4F772D",
        "M&E": "#386641", "M&E Delivery": "#2B580C", "Deliver to QC v1": "#ffb703", "Final Delivery": "#fb8500",
        "Earliest Possible Release": "#457b9d"
    };
    const AppDr_g0n = atob('VFYgUG9zdCBQcm9kdWN0aW9uIFNjaGVkdWxlciBBcHAgRGVzaWduZWQgYnkgQW5kcmUgRGFueWxldmljaA==');

    // --- CORE ACTIONS & ORCHESTRATION ---
    function debounce(func, delay) {
        return function(...args) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => func.apply(this, args), delay);
        };
    }

    const debouncedGenerate = debounce(() => {
        fullRegeneration();
    }, 300);

    function fullRegeneration() {
        const customTasks = masterTaskList.filter(t => t.id.includes('freetask'));
        const manuallySetTasks = masterTaskList.filter(t => t.isManuallySet && !t.id.includes('freetask'));
        
        // If there are manually set tasks, use enhanced conflict detection
        if (manuallySetTasks.length > 0) {
            // Store detailed information about manually set tasks including their logical relationships
            const manualTasksData = manuallySetTasks.map(task => ({
                id: task.id,
                epId: task.epId,
                taskName: task.info.name,
                scheduledStartDate: new Date(task.scheduledStartDate),
                scheduledEndDate: new Date(task.scheduledEndDate),
                isManuallySet: task.isManuallySet,
                resources: [...task.resources],
                // Store logical predecessor relationships, not object references
                logicalPredecessors: task.predecessors ? task.predecessors.map(p => ({
                    epId: p.task.epId,
                    taskName: p.task.info.name,
                    delay: p.delay
                })) : []
            }));
            
            // Store current state for comparison
            const previousSchedule = masterTaskList.filter(t => t.isScheduled).map(t => ({
                id: t.id,
                scheduledStartDate: new Date(t.scheduledStartDate),
                scheduledEndDate: new Date(t.scheduledEndDate),
                isManuallySet: t.isManuallySet
            }));
            
            // Clear and regenerate
            masterTaskList = [];
            masterTaskList.push(...customTasks);
            
            // Generate fresh schedule
            generateScheduleFromScratch();
            
            // Now restore the manually set tasks with proper relationships
            restoreManuallySetTasks(manualTasksData);
            
            // Run conflict detection
            calculateScheduleWithConflictDetection(previousSchedule, 
                masterTaskList.filter(t => t.isManuallySet && !t.id.includes('freetask')));
        } else {
            // No manual tasks, proceed normally
            masterTaskList = [];
            masterTaskList.push(...customTasks);
            
            generateScheduleFromScratch();
            calculateAndRender();
        }
    }

// New function to properly restore manually set tasks after regeneration
function restoreManuallySetTasks(manualTasksData) {
    manualTasksData.forEach(manualData => {
        // Find the corresponding newly generated task
        const newTask = masterTaskList.find(t => 
            t.epId === manualData.epId && 
            t.info.name === manualData.taskName
        );
        
        if (newTask) {
            // Restore the manual properties
            newTask.isManuallySet = true;
            newTask.scheduledStartDate = manualData.scheduledStartDate;
            newTask.scheduledEndDate = manualData.scheduledEndDate;
            newTask.isScheduled = true;
            newTask.resources = [...manualData.resources];
            
            // Restore logical predecessor relationships
            if (manualData.logicalPredecessors.length > 0) {
                newTask.predecessors = manualData.logicalPredecessors.map(logicalPred => {
                    const predTask = masterTaskList.find(t => 
                        t.epId === logicalPred.epId && 
                        t.info.name === logicalPred.taskName
                    );
                    return predTask ? { task: predTask, delay: logicalPred.delay } : null;
                }).filter(p => p !== null);
            } else {
                // If no predecessors were stored, clear them (was manually unlinked)
                newTask.predecessors = [];
            }
        }
    });
}

function calculateScheduleWithConflictDetection(previousSchedule, manuallySetTasks) {
    // Ensure manually set tasks maintain their scheduled state
    manuallySetTasks.forEach(task => {
        if (task.isManuallySet && task.scheduledStartDate) {
            task.isScheduled = true;
        }
    });
    
    const tempSchedule = calculateIdealSchedule();
    const conflicts = detectAdvancedConflicts(tempSchedule, manuallySetTasks);
    
    if (conflicts.length > 0 && !conflictResolutionMode) {
        showConflictModal(conflicts);
    } else {
        calculateSchedule();
        calculateAndRender();
    }
}

// ENHANCED CONFLICT DETECTION AND RESOLUTION SYSTEM
let conflictResolutionMode = false;
let lastChangedInputId = null;

// Global change tracking
window.lastChangedInputId = null;

function setLastChangedInput(inputId) {
    window.lastChangedInputId = inputId;
    lastChangedInputId = inputId;
}


// Calculate ideal schedule without manual interventions
function calculateIdealSchedule() {
    const idealTaskList = masterTaskList.map(task => {
        const idealTask = { ...task };
        if (idealTask.isManuallySet && !idealTask.id.includes('freetask')) {
            idealTask.isManuallySet = false;
            idealTask.isScheduled = false;
            if (idealTask.originalPredecessors) {
                idealTask.predecessors = idealTask.originalPredecessors.map(p => ({ ...p }));
            }
        }
        return idealTask;
    });
    
    const originalList = [...masterTaskList];
    masterTaskList = idealTaskList;
    calculateSchedule();
    const idealSchedule = masterTaskList.filter(t => t.isScheduled).map(t => ({
        id: t.id,
        idealStartDate: new Date(t.scheduledStartDate),
        idealEndDate: new Date(t.scheduledEndDate)
    }));
    
    masterTaskList = originalList;
    return idealSchedule;
}

// Advanced conflict detection with better intelligence
function detectAdvancedConflicts(idealSchedule, manuallySetTasks) {
    const conflicts = [];
    
    manuallySetTasks.forEach(manualTask => {
        const idealTask = idealSchedule.find(t => t.id === manualTask.id);
        if (!idealTask) return;
        
        const isDirectlyAffected = isTaskDirectlyAffectedByGlobalChange(manualTask);
        const wouldCreateConflict = checkForScheduleConflicts(manualTask, idealSchedule);
        
        // Calculate time difference
        const timeDiff = Math.abs(idealTask.idealStartDate - manualTask.scheduledStartDate);
        const daysDiff = timeDiff / (1000 * 60 * 60 * 24);
        
        // Determine if this is a significant conflict
        const isSignificantConflict = daysDiff > 1 || isDirectlyAffected || wouldCreateConflict;
        
        if (isSignificantConflict) {
            conflicts.push({
                task: manualTask,
                idealStartDate: idealTask.idealStartDate,
                idealEndDate: idealTask.idealEndDate,
                currentStartDate: manualTask.scheduledStartDate,
                currentEndDate: manualTask.scheduledEndDate,
                daysDiff: Math.round(daysDiff),
                isDirectlyAffected: isDirectlyAffected,
                wouldCreateConflict: wouldCreateConflict,
                reason: getConflictReason(manualTask, idealTask, isDirectlyAffected, wouldCreateConflict)
            });
        }
    });
    
    return conflicts;
}

// Check if task is directly affected by global change
function isTaskDirectlyAffectedByGlobalChange(task) {
    const changedId = lastChangedInputId;
    if (!changedId) return false;
    
    // Task duration changes
    const durationMappings = {
        'editors-cut-days': "Editor's Cut",
        'directors-cut-days': ["Director's Cut", "Director's Cut v2"],
        'producers-cut-days': "Producer's Cut",
        'studio-notes-days': "Notes",
        'network-cut-days': "Studio/Network Cut",
        'picture-lock-days': "Picture Lock"
    };
    
    for (const [inputId, taskNames] of Object.entries(durationMappings)) {
        if (changedId === inputId) {
            const names = Array.isArray(taskNames) ? taskNames : [taskNames];
            if (names.some(name => task.info.name.startsWith(name))) {
                return true;
            }
        }
    }
    
    // Finishing period changes
    if (changedId === 'finishing-period-weeks' && 
        ['VFX Due', 'Online Conform', 'Color Grade', 'Final Mix', 'M&E Delivery'].includes(task.info.name)) {
        return true;
    }
    
    // Studio cuts per episode changes
    if (changedId.startsWith('ep-studio-cuts-') && task.info.name.startsWith("Studio/Network Cut")) {
        const epId = changedId.split('-')[3];
        return task.epId === parseInt(epId);
    }
    
    // Personnel assignment changes
    if ((changedId.startsWith('editor-eps-') || changedId.startsWith('director-eps-')) && 
        task.info.department === 'EDIT') {
        return true;
    }
    
    // Structural changes that affect everything
    const structuralChanges = [
        'num-episodes', 'num-editors', 'num-directors', 'num-shoot-blocks', 
        'start-of-photography', 'shoot-days-per-ep', 'toggle-sequential-lock',
        'producers-cuts-overlap', 'producers-cuts-pre-wrap'
    ];
    
    if (structuralChanges.includes(changedId)) {
        return true;
    }
    
    return false;
}

// Check for various types of schedule conflicts
function checkForScheduleConflicts(manualTask, idealSchedule) {
    // Check for resource conflicts with other scheduled tasks
    const resourceConflicts = masterTaskList.filter(t => 
        t.id !== manualTask.id &&
        t.isScheduled &&
        t.resources.some(r => manualTask.resources.includes(r)) &&
        !(manualTask.scheduledEndDate <= t.scheduledStartDate || 
          manualTask.scheduledStartDate >= t.scheduledEndDate)
    );
    
    if (resourceConflicts.length > 0) return true;
    
    // Check for dependency violations
    const dependents = masterTaskList.filter(t => 
        t.predecessors && t.predecessors.some(p => p.task.id === manualTask.id)
    );
    
    for (const dependent of dependents) {
        if (dependent.isScheduled && dependent.scheduledStartDate < manualTask.scheduledEndDate) {
            return true;
        }
    }
    
    // Check if manual position violates predecessor constraints
    for (const pred of manualTask.predecessors) {
        if (pred.task && pred.task.isScheduled && 
            manualTask.scheduledStartDate < pred.task.scheduledEndDate) {
            return true;
        }
    }
    
    return false;
}

// Get detailed conflict reason
function getConflictReason(manualTask, idealTask, isDirectlyAffected, wouldCreateConflict) {
    if (isDirectlyAffected) {
        return "Task duration or dependencies changed by your global update";
    }
    
    if (wouldCreateConflict) {
        return "Manual position creates resource or dependency conflicts";
    }
    
    const daysDiff = Math.abs(idealTask.idealStartDate - manualTask.scheduledStartDate) / (1000 * 60 * 60 * 24);
    if (daysDiff > 7) {
        return "Manual position is significantly different from optimal schedule";
    }
    
    return "Manual position may need adjustment due to schedule changes";
}

// Create conflict item element for modal
function createConflictItemElement(conflict, index) {
    const div = document.createElement('div');
    div.className = 'conflict-item';
    
    const formatDate = (date) => date.toLocaleDateString('en-US', { 
        month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC' 
    });
    
    div.innerHTML = `
        <div class="conflict-task-info">
            <strong>EP ${conflict.task.epId + 1}: ${conflict.task.info.name}</strong>
            <div class="conflict-dates">
                <div class="current-date">Current: ${formatDate(conflict.currentStartDate)}</div>
                <div class="recommended-date">Recommended: ${formatDate(conflict.idealStartDate)}</div>
                <div class="conflict-reason">${conflict.reason}</div>
                ${conflict.daysDiff > 0 ? `<div class="days-diff">${conflict.daysDiff} day${conflict.daysDiff !== 1 ? 's' : ''} difference</div>` : ''}
            </div>
        </div>
        <div class="conflict-choice">
            <label>
                <input type="radio" name="conflict-${index}" value="preserve" ${!conflict.isDirectlyAffected ? 'checked' : ''}>
                Keep Current Position
            </label>
            <label>
                <input type="radio" name="conflict-${index}" value="update" ${conflict.isDirectlyAffected ? 'checked' : ''}>
                Move to Recommended Position
            </label>
        </div>
    `;
    
    return div;
}

// Show conflict modal with enhanced UI
function showConflictModal(conflicts) {
    const modal = document.getElementById('conflict-resolution-modal');
    const conflictList = document.getElementById('conflict-list');
    
    // Clear existing content
    conflictList.innerHTML = '';
    
    // Create conflict items
    conflicts.forEach((conflict, index) => {
        const conflictItem = createConflictItemElement(conflict, index);
        conflictList.appendChild(conflictItem);
    });
    
    // Setup event listeners
    setupConflictModalEventListeners(modal, conflicts);
    
    // Show modal
    modal.style.display = 'flex';
}

// Setup modal event listeners with improved logic
function setupConflictModalEventListeners(modal, conflicts) {
    // Remove any existing listeners
    const existingModal = document.querySelector('#conflict-resolution-modal[data-listeners="true"]');
    if (existingModal) {
        existingModal.removeAttribute('data-listeners');
    }
    
    modal.setAttribute('data-listeners', 'true');
    
    // Close button
    document.getElementById('conflict-modal-close-btn').onclick = () => {
        closeConflictModal();
    };
    
    // Apply recommended (smart default based on whether tasks are directly affected)
    document.getElementById('conflict-apply-recommended').onclick = () => {
        const choices = {};
        conflicts.forEach((conflict, index) => {
            choices[conflict.task.id] = conflict.isDirectlyAffected ? 'update' : 'preserve';
        });
        applyConflictResolution(conflicts, 'selective', choices);
        closeConflictModal();
    };
    
    // Preserve all manual positions
    document.getElementById('conflict-preserve-all').onclick = () => {
        applyConflictResolution(conflicts, 'preserve-all');
        closeConflictModal();
    };
    
    // Update all to recommended positions
    document.getElementById('conflict-update-all').onclick = () => {
        applyConflictResolution(conflicts, 'update-all');
        closeConflictModal();
    };
    
    // Apply selective choices
    document.getElementById('conflict-apply-selective').onclick = () => {
        const choices = getSelectiveChoices(conflicts);
        applyConflictResolution(conflicts, 'selective', choices);
        closeConflictModal();
    };
    
    // Cancel changes
    document.getElementById('conflict-cancel').onclick = () => {
        cancelGlobalChanges();
        closeConflictModal();
    };
    
    // Click outside to close
    modal.onclick = (e) => {
        if (e.target === modal) {
            closeConflictModal();
        }
    };
}

// Get selective choices from modal form
function getSelectiveChoices(conflicts) {
    const choices = {};
    conflicts.forEach((conflict, index) => {
        const selected = document.querySelector(`input[name="conflict-${index}"]:checked`);
        choices[conflict.task.id] = selected ? selected.value : 'preserve';
    });
    return choices;
}

// Apply conflict resolution with improved logic
function applyConflictResolution(conflicts, mode, choices = {}) {
    conflictResolutionMode = true;
    
    conflicts.forEach(conflict => {
        const task = masterTaskList.find(t => t.id === conflict.task.id);
        if (!task) return;
        
        let action = mode;
        if (mode === 'selective') {
            action = choices[task.id] || 'preserve';
        } else if (mode === 'preserve-all') {
            action = 'preserve';
        } else if (mode === 'update-all') {
            action = 'update';
        }
        
        switch (action) {
            case 'preserve':
                // Keep the manual position
                task.isManuallySet = true;
                break;
                
            case 'update':
                // Move to recommended position
                task.isManuallySet = false;
                task.isScheduled = false;
                // Restore original dependencies
                if (task.originalPredecessors) {
                    task.predecessors = task.originalPredecessors.map(p => ({ ...p }));
                }
                break;
        }
    });
    
    calculateSchedule();
    calculateAndRender();
    conflictResolutionMode = false;
}

// Close conflict modal
function closeConflictModal() {
    const modal = document.getElementById('conflict-resolution-modal');
    modal.style.display = 'none';
}

// Cancel global changes and revert
function cancelGlobalChanges() {
    conflictResolutionMode = false;
    // Simply recalculate with current state
    calculateSchedule();
    calculateAndRender();
}

// Check for immediate conflicts when manually moving tasks
function checkImmediateConflicts(task) {
    const conflicts = [];
    
    // Check resource conflicts
    const resourceConflicts = masterTaskList.filter(t => 
        t.id !== task.id &&
        t.isScheduled &&
        t.isManuallySet &&
        t.resources.some(r => task.resources.includes(r)) &&
        !(task.scheduledEndDate <= t.scheduledStartDate || 
          task.scheduledStartDate >= t.scheduledEndDate)
    );
    
    conflicts.push(...resourceConflicts);
    
    return conflicts;
}

// Enhanced validation function for manual anchors
function validateManualAnchors(manuallySetTasks) {
    manuallySetTasks.forEach(task => {
        if (task.isManuallySet && task.scheduledStartDate && task.scheduledEndDate) {
            // Ensure manually set tasks keep their dates and scheduled state
            task.isScheduled = true;
            
            // Validate that the end date is correct based on duration
            const expectedEndDate = addBusinessDays(task.scheduledStartDate, task.info.duration, task.info.department, task.epId, task.resources);
            if (Math.abs(task.scheduledEndDate.getTime() - expectedEndDate.getTime()) > 24 * 60 * 60 * 1000) {
                // If end date is off by more than a day, recalculate it
                task.scheduledEndDate = expectedEndDate;
            }
        }
    });
}
    function renderAllViews() {
        renderGanttChart();
        renderWaterfallChart();
        renderGridView();
        renderBudgetView();
        viewState = { timeline: 'fresh', waterfall: 'fresh', grid: 'fresh', budget: 'fresh' };
    }

    function calculateAndRender() {
        calculateSchedule();
        updateBudgetFromSchedule();
        renderAllViews();
    }

    // --- EVENT LISTENERS ---
    document.getElementById('load-hour-long').addEventListener('click', () => loadDefaults('hour-long'));
    document.getElementById('load-half-hour').addEventListener('click', () => loadDefaults('half-hour'));

    function loadDefaults(type) {
        scheduleType = type;
        const numEpisodes = parseInt(document.getElementById('num-episodes').value);
        const numEditors = parseInt(document.getElementById('num-editors').value);

        if (type === 'hour-long') {
            document.getElementById('shoot-days-per-ep').value = 8;
            document.getElementById('editors-cut-days').value = 3;
            document.getElementById('directors-cut-days').value = 4;
            document.getElementById('producers-cut-days').value = 10;
            document.getElementById('studio-notes-days').value = 4;
            document.getElementById('network-cut-days').value = 4;
            document.getElementById('picture-lock-days').value = 3;
            document.getElementById('finishing-period-weeks').value = 10;
        } else { // half-hour
            document.getElementById('shoot-days-per-ep').value = 5;
            document.getElementById('editors-cut-days').value = 2;
            document.getElementById('directors-cut-days').value = 2;
            document.getElementById('producers-cut-days').value = 5;
            document.getElementById('studio-notes-days').value = 2;
            document.getElementById('network-cut-days').value = 2;
            document.getElementById('picture-lock-days').value = 1;
            document.getElementById('finishing-period-weeks').value = 6;
        }

        generateStudioCutFields();

        const staffItems = [
            { id: generateUUID(), desc: 'Post Producer', num: 1, prep: 4, shoot: 10, post: 20, wrap: 2, rate: 4000, fringeType: 'percent', fringeRate: 25 },
            { id: generateUUID(), desc: 'Post Supervisor', num: 1, prep: 4, shoot: 10, post: 20, wrap: 2, rate: 2500, fringeType: 'percent', fringeRate: 25 },
            { id: generateUUID(), desc: 'Post Coordinator', num: 1, prep: 2, shoot: 10, post: 20, wrap: 2, rate: 1800, fringeType: 'percent', fringeRate: 25 },
            { id: generateUUID(), desc: 'Post PA', num: 1, prep: 0, shoot: 10, post: 20, wrap: 2, rate: 1200, fringeType: 'percent', fringeRate: 25 },
        ];

        const editorialItems = [];
        for (let i = 0; i < numEditors; i++) {
            editorialItems.push({ id: generateUUID(), desc: `Editor ${i+1}`, num: 1, prep: 0, shoot: 0, post: 20, wrap: 1, rate: 5500, fringeType: 'percent', fringeRate: 40 });
            editorialItems.push({ id: generateUUID(), desc: `Assistant Editor ${i+1}`, num: 1, prep: 2, shoot: 0, post: 22, wrap: 2, rate: 3200, fringeType: 'percent', fringeRate: 40 });
        }
        editorialItems.push({ id: generateUUID(), desc: 'VFX Editor', num: 1, prep: 0, shoot: 10, post: 20, wrap: 2, rate: 4000, fringeType: 'percent', fringeRate: 40 });
        editorialItems.push({ id: generateUUID(), desc: 'MX Editor', num: 1, prep: 0, shoot: 0, post: 8, wrap: 0, rate: 5000, fringeType: 'percent', fringeRate: 40 });

        const vfxItems = [
            { id: generateUUID(), desc: 'VFX Producer', num: 1, prep: 4, shoot: 10, post: 20, wrap: 2, rate: 4000, fringeType: 'percent', fringeRate: 25 },
            { id: generateUUID(), desc: 'VFX Supervisor', num: 1, prep: 4, shoot: 10, post: 20, wrap: 2, rate: 5000, fringeType: 'percent', fringeRate: 25 },
            { id: generateUUID(), desc: 'VFX Coordinator', num: 1, prep: 2, shoot: 10, post: 20, wrap: 2, rate: 2500, fringeType: 'percent', fringeRate: 25 },
            { id: generateUUID(), desc: 'VFX Wrangler', num: 1, prep: 0, shoot: 10, post: 0, wrap: 0, rate: 2200, fringeType: 'percent', fringeRate: 25 },
            { id: generateUUID(), desc: 'VFX PA', num: 1, prep: 0, shoot: 10, post: 20, wrap: 2, rate: 1200, fringeType: 'percent', fringeRate: 25 },
        ];

        const roomItems = [
            { id: generateUUID(), desc: 'Post Producer Room', num: 1, prep: 4, shoot: 10, post: 20, wrap: 2, rate: 400, fringeType: 'flat', fringeRate: 0 },
            { id: generateUUID(), desc: 'Post Supervisor Room', num: 1, prep: 4, shoot: 10, post: 20, wrap: 2, rate: 400, fringeType: 'flat', fringeRate: 0 },
            { id: generateUUID(), desc: 'VFX Producer Room', num: 1, prep: 4, shoot: 10, post: 20, wrap: 2, rate: 400, fringeType: 'flat', fringeRate: 0 },
            { id: generateUUID(), desc: 'VFX Supervisor Room', num: 1, prep: 4, shoot: 10, post: 20, wrap: 2, rate: 400, fringeType: 'flat', fringeRate: 0 },
            { id: generateUUID(), desc: 'VFX Coordinator Room', num: 1, prep: 2, shoot: 10, post: 20, wrap: 2, rate: 350, fringeType: 'flat', fringeRate: 0 },
            { id: generateUUID(), desc: 'MX Editor Room', num: 1, prep: 0, shoot: 0, post: 8, wrap: 0, rate: 500, fringeType: 'flat', fringeRate: 0 },
        ];
        for (let i = 0; i < numEditors; i++) {
            roomItems.push({ id: generateUUID(), desc: `Editor Bay ${i+1}`, num: 1, prep: 0, shoot: 0, post: 22, wrap: 2, rate: 600, fringeType: 'flat', fringeRate: 0 });
            roomItems.push({ id: generateUUID(), desc: `Assistant Editor Bay ${i+1}`, num: 1, prep: 2, shoot: 0, post: 22, wrap: 2, rate: 600, fringeType: 'flat', fringeRate: 0 });
        }

        const equipmentItems = [];
         for (let i = 0; i < numEditors; i++) {
            equipmentItems.push({ id: generateUUID(), desc: `AVID Rental (Editor ${i+1})`, num: 1, prep: 0, shoot: 0, post: 22, wrap: 2, rate: 650, fringeType: 'flat', fringeRate: 0 });
            equipmentItems.push({ id: generateUUID(), desc: `AVID Rental (Assistant Editor ${i+1})`, num: 1, prep: 2, shoot: 0, post: 22, wrap: 2, rate: 650, fringeType: 'flat', fringeRate: 0 });
        }
        equipmentItems.push({ id: generateUUID(), desc: 'AVID Rental (VFX Editor)', num: 1, prep: 0, shoot: 0, post: 20, wrap: 2, rate: 650, fringeType: 'flat', fringeRate: 0 });
        equipmentItems.push({ id: generateUUID(), desc: 'MX Editor Kit Rental', num: 1, prep: 0, shoot: 0, post: 8, wrap: 0, rate: 1500, fringeType: 'flat', fringeRate: 0 });

        budgetData = {
            "Post-Production Staff": staffItems,
            "Editorial": editorialItems,
            "VFX": vfxItems,
            "Rooms": roomItems,
            "Equipment Rentals": equipmentItems,
            "Box Rentals": []
        };

        const boxRentalEligible = [...staffItems, ...editorialItems, ...vfxItems].filter(item => !item.desc.toLowerCase().includes('mx editor'));
        budgetData["Box Rentals"] = boxRentalEligible.map(item => ({
             id: generateUUID(),
             desc: `Box Rental (${item.desc})`,
             num: item.num,
             prep: item.prep,
             shoot: item.shoot,
             post: item.post,
             wrap: item.wrap,
             rate: 50,
             fringeType: 'capped',
             fringeRate: 500
        }));

        document.querySelector('.personnel-assignments').addEventListener('change', (e) => {
            if (e.target.matches('select')) {
                debouncedGenerate();
            }
        });

        document.querySelector('.personnel-assignments').addEventListener('input', (e) => {
            if (e.target.matches('input[type="text"]')) {
                debouncedGenerate();
            }
        });
        generatePersonnelFields();
        generateBlockFields();
        initializeDefaultHiatus();
        updateWrapDate();
        fullRegeneration();
        gridVisibleColumns = getCurrentAllGridColumns();
        renderGridView();
    }

// ENHANCED EVENT LISTENER AND GLOBAL CHANGE TRACKING SYSTEM
    
    // Define what constitutes a global change that might affect manual tasks
    const globalChangeEvents = new Set([
        'toggle-sequential-lock',
        'producers-cuts-overlap', 
        'producers-cuts-pre-wrap',
        'start-of-photography',
        'num-episodes',
        'num-editors', 
        'num-directors',
        'num-shoot-blocks',
        'shoot-days-per-ep',
        'editors-cut-days',
        'directors-cut-days',
        'producers-cut-days',
        'studio-notes-days',
        'network-cut-days',
        'picture-lock-days',
        'finishing-period-weeks',
        'online-days',
        'color-grade-days',
        'pre-mix-days',
        'final-mix-days',
        'mix-review-days',
        'final-mix-fixes-days',
        'days-to-air',
        'air-unit'
    ]);

    // Enhanced input change handler with better global change detection
function handleInputChange(inputElement) {
    const id = inputElement.id;
    setLastChangedInput(id);
    
    // Skip processing for metadata fields
    if (['show-name', 'show-code', 'schedule-version', 'created-by'].includes(id)) {
        if (id === 'show-name') {
            autoPopulateShowCode(inputElement.value);
        }
        return;
    }
    
    // Define which changes require full regeneration vs simple recalculation
    const fullRegenerationTriggers = new Set([
        'num-episodes', 'num-editors', 'num-directors', 'num-shoot-blocks'
    ]);
    
    const globalRecalculationTriggers = new Set([
        'toggle-sequential-lock', 'producers-cuts-overlap', 'producers-cuts-pre-wrap',
        'start-of-photography', 'shoot-days-per-ep', 'editors-cut-days',
        'directors-cut-days', 'producers-cut-days', 'studio-notes-days',
        'network-cut-days', 'picture-lock-days', 'finishing-period-weeks',
        'online-days', 'color-grade-days', 'pre-mix-days', 'final-mix-days',
        'mix-review-days', 'final-mix-fixes-days', 'days-to-air', 'air-unit'
    ]);
    
    const isFullRegeneration = fullRegenerationTriggers.has(id) || 
                             id.startsWith('ep-studio-cuts-') ||
                             id.startsWith('editor-eps-') ||
                             id.startsWith('director-eps-');
    
    const isGlobalRecalculation = globalRecalculationTriggers.has(id);
    
    if (isFullRegeneration) {
        // These changes require full regeneration of tasks
        if (id === 'num-editors') {
            updateBudgetForEditorCount();
        }
        generatePersonnelFields();
        generateStudioCutFields();
        generateBlockFields();
        updateWrapDate();
        fullRegeneration();
        gridVisibleColumns = getCurrentAllGridColumns();
        renderGridView();
    } else if (isGlobalRecalculation) {
        // Update global variables as needed
        if (id === 'toggle-sequential-lock') {
            enforceSequentialLock = inputElement.checked;
        }
        
        // These changes affect scheduling logic but don't require task regeneration
        const hasManualTasks = masterTaskList.some(t => t.isManuallySet && !t.id.includes('freetask'));
        
        if (hasManualTasks) {
            // Store the current state of manual tasks
            const manualTasksState = masterTaskList
                .filter(t => t.isManuallySet && !t.id.includes('freetask'))
                .map(t => ({
                    id: t.id,
                    scheduledStartDate: new Date(t.scheduledStartDate),
                    scheduledEndDate: new Date(t.scheduledEndDate),
                    isManuallySet: t.isManuallySet,
                    predecessors: t.predecessors ? [...t.predecessors] : []
                }));
            
            // Recalculate schedule
            calculateAndRender();
            
            // Check if any manual tasks were affected
            const conflicts = checkForManualTaskConflicts(manualTasksState);
            if (conflicts.length > 0 && !conflictResolutionMode) {
                showConflictModal(conflicts);
            }
        } else {
            // No manual tasks, simple recalculation
            calculateAndRender();
        }
    } else {
        // Local change - just regenerate
        debouncedGenerate();
    }
}

// Helper function to check if global changes affected manual tasks
function checkForManualTaskConflicts(originalManualTasksState) {
    const conflicts = [];
    
    originalManualTasksState.forEach(originalState => {
        const currentTask = masterTaskList.find(t => t.id === originalState.id);
        if (!currentTask) return;
        
        // Calculate what the ideal position would be for this task
        const tempTask = { ...currentTask };
        tempTask.isManuallySet = false;
        tempTask.isScheduled = false;
        
        // Get other non-manual scheduled tasks to determine ideal position
        const otherScheduledTasks = masterTaskList.filter(t => 
            t.isScheduled && 
            t.id !== currentTask.id && 
            !t.isManuallySet
        );
        
        if (otherScheduledTasks.length > 0) {
            // Simple heuristic: check if manual task is significantly displaced from similar tasks
            const similarTasks = otherScheduledTasks.filter(t => 
                t.info.name === currentTask.info.name && 
                Math.abs(t.epId - currentTask.epId) <= 1
            );
            
            if (similarTasks.length > 0) {
                const avgStartTime = similarTasks.reduce((sum, t) => sum + t.scheduledStartDate.getTime(), 0) / similarTasks.length;
                const idealStartDate = new Date(avgStartTime);
                const timeDiff = Math.abs(currentTask.scheduledStartDate - idealStartDate);
                const daysDiff = timeDiff / (1000 * 60 * 60 * 24);
                
                if (daysDiff > 2) { // Only flag significant differences
                    conflicts.push({
                        task: currentTask,
                        idealStartDate: idealStartDate,
                        idealEndDate: addBusinessDays(idealStartDate, currentTask.info.duration, currentTask.info.department, currentTask.epId, currentTask.resources),
                        currentStartDate: currentTask.scheduledStartDate,
                        currentEndDate: currentTask.scheduledEndDate,
                        daysDiff: Math.round(daysDiff),
                        isDirectlyAffected: isTaskDirectlyAffectedByGlobalChange(currentTask),
                        wouldCreateConflict: false,
                        reason: "Global scheduling change affects this task's optimal position"
                    });
                }
            }
        }
    });
    
    return conflicts;
}



    // Handle global changes with enhanced conflict detection
    function handleGlobalChange(inputElement) {
        const id = inputElement.id;
        const hasManualTasks = masterTaskList.some(t => t.isManuallySet && !t.id.includes('freetask'));
        
        // Check if this change requires special handling
        const requiresRegeneration = id.startsWith('num-') || 
                                   id.includes('shoot-days-per-ep') || 
                                   id.includes('shoot-day-overrides') || 
                                   id.includes('num-shoot-blocks') || 
                                   id.startsWith('ep-studio-cuts-');
        
        if (requiresRegeneration) {
            // Handle special regeneration cases
            if (id === 'num-editors') {
                updateBudgetForEditorCount();
            }
            if (id.startsWith('num-')) {
                generatePersonnelFields();
                generateStudioCutFields();
                generateBlockFields();
            }
            updateWrapDate();
            
            if (hasManualTasks) {
                fullRegenerationWithConflictDetection();
            } else {
                fullRegeneration();
            }
            
            gridVisibleColumns = getCurrentAllGridColumns();
            renderGridView();
        } else {
            // Standard global change
            if (hasManualTasks) {
                debouncedGenerateWithConflictDetection();
            } else {
                debouncedGenerate();
            }
        }
    }

    // Enhanced debounced generation with conflict detection
    const debouncedGenerateWithConflictDetection = debounce(() => {
        fullRegenerationWithConflictDetection();
    }, 300);

    function fullRegenerationWithConflictDetection() {
        const customTasks = masterTaskList.filter(t => t.id.includes('freetask'));
        const manuallySetTasks = masterTaskList.filter(t => t.isManuallySet && !t.id.includes('freetask'));
        
        // Store complete state of manual tasks
        const manualTaskData = manuallySetTasks.map(task => ({
            id: task.id,
            scheduledStartDate: task.scheduledStartDate ? new Date(task.scheduledStartDate) : null,
            scheduledEndDate: task.scheduledEndDate ? new Date(task.scheduledEndDate) : null,
            isManuallySet: task.isManuallySet,
            isScheduled: task.isScheduled,
            originalPredecessors: task.originalPredecessors ? [...task.originalPredecessors] : null,
            epId: task.epId,
            info: {...task.info}
        }));
        
        if (manuallySetTasks.length > 0) {
            // Store current state for comparison
            const previousSchedule = masterTaskList.filter(t => t.isScheduled).map(t => ({
                id: t.id,
                scheduledStartDate: new Date(t.scheduledStartDate),
                scheduledEndDate: new Date(t.scheduledEndDate),
                isManuallySet: t.isManuallySet
            }));
            
            masterTaskList = [];
            masterTaskList.push(...customTasks);
            
            generateScheduleFromScratch();
            
            // Restore manual tasks after regeneration
            manualTaskData.forEach(manualData => {
                const regeneratedTask = masterTaskList.find(t => 
                    t.epId === manualData.epId && 
                    t.info.name === manualData.info.name
                );
                
                if (regeneratedTask) {
                    regeneratedTask.scheduledStartDate = manualData.scheduledStartDate;
                    regeneratedTask.scheduledEndDate = manualData.scheduledEndDate;
                    regeneratedTask.isManuallySet = true;
                    regeneratedTask.isScheduled = true;
                    regeneratedTask.originalPredecessors = manualData.originalPredecessors;
                    regeneratedTask.predecessors = [];
                }
            });
            
            calculateScheduleWithConflictDetection(previousSchedule, manuallySetTasks);
        } else {
            // No manual tasks, proceed normally
            masterTaskList = [];
            masterTaskList.push(...customTasks);
            
            generateScheduleFromScratch();
            calculateAndRender();
        }
    }

    // Check if a change would affect manual tasks
    function checkIfChangeWouldAffectManualTasks(inputElement) {
        const id = inputElement.id;
        
        // Always consider structural changes as affecting manual tasks
        if (['num-episodes', 'num-editors', 'num-directors', 'num-shoot-blocks', 
             'start-of-photography', 'toggle-sequential-lock'].includes(id)) {
            return true;
        }
        
        // Check if any manual tasks would be directly affected
        const manualTasks = masterTaskList.filter(t => t.isManuallySet && !t.id.includes('freetask'));
        return manualTasks.some(task => isTaskDirectlyAffectedByGlobalChange(task));
    }

    // Enhanced input change detection with better user experience
function setupEnhancedInputListeners() {
    // Store original values to detect actual changes
    const originalValues = new Map();
    
    // Main input event listeners
    document.querySelectorAll('.controls input:not(#unlink-on-manual-move), .controls select, .schedule-variables input, .holiday-settings input, #air-unit').forEach(input => {
        // Store original value
        originalValues.set(input.id, input.value);
        
        // Remove any existing listeners to prevent duplicates
        input.removeEventListener('input', handleInputChange);
        input.removeEventListener('change', handleInputChange);
        
        // Add focus listener to capture the value when editing starts
        input.addEventListener('focus', (e) => {
            originalValues.set(e.target.id, e.target.value);
        });
        
        // Add the new enhanced listener
        if (input.type === 'checkbox' || input.tagName === 'SELECT') {
            input.addEventListener('change', (e) => {
                const originalValue = originalValues.get(e.target.id);
                const newValue = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
                
                // Only process if the value actually changed
                if (originalValue != newValue) { // Use != to handle string/boolean conversion
                    originalValues.set(e.target.id, newValue);
                    handleInputChange(e.target);
                }
            });
        } else {
            input.addEventListener('input', (e) => {
                const originalValue = originalValues.get(e.target.id);
                const newValue = e.target.value;
                
                // Only process if the value actually changed
                if (originalValue !== newValue) {
                    originalValues.set(e.target.id, newValue);
                    handleInputChange(e.target);
                }
            });
        }
    });

    // Personnel assignment listeners - use new handleInputChange
    document.querySelector('.personnel-assignments').addEventListener('change', (e) => {
        if (e.target.matches('select')) {
            handleInputChange(e.target);
        }
    });

    document.querySelector('.personnel-assignments').addEventListener('input', (e) => {
        if (e.target.matches('input[type="text"]')) {
            handleInputChange(e.target);
        }
    });

    // Block distribution listeners - use new handleInputChange
    document.getElementById('block-distribution-container').addEventListener('change', (e) => {
        if (e.target.matches('input[type="number"]')) {
            handleInputChange(e.target);
            updateDirectorAssignmentsFromBlocks();
        }
    });

    // Holiday controls
    document.getElementById('holiday-region-controls').addEventListener('change', (e) => {
        setLastChangedInput(e.target.id);
        calculateAndRender();
    });
}

    // Process input changes with enhanced logic
    function processInputChange(inputElement) {
        const id = inputElement.id;
        
        // Check if this is a global change that might affect manually set tasks
        const isGlobalChange = globalChangeEvents.has(id) || 
                             id.startsWith('num-') || 
                             id.includes('shoot-days-per-ep') || 
                             id.includes('shoot-day-overrides') || 
                             id.includes('num-shoot-blocks') || 
                             id.startsWith('ep-studio-cuts-');
        
        // Skip processing for metadata fields
        if (['show-name', 'show-code', 'schedule-version', 'created-by'].includes(id)) {
            if(id === 'show-name') autoPopulateShowCode(inputElement.value);
            return;
        }
        
        if (isGlobalChange) {
            const hasManualTasks = masterTaskList.some(t => t.isManuallySet && !t.id.includes('freetask'));
            
            if (hasManualTasks) {
                // Check if this change would actually affect any manual tasks
                const wouldAffectManualTasks = checkIfChangeWouldAffectManualTasks(inputElement);
                
                if (wouldAffectManualTasks) {
                    // Show enhanced conflict detection
                    processGlobalChangeWithConflictDetection(inputElement);
                } else {
                    // Won't affect manual tasks, proceed normally but preserve them
                    processGlobalChangePreservingManualTasks(inputElement);
                }
            } else {
                // No manual tasks, proceed normally
                processNormalGlobalChange(inputElement);
            }
        } else {
            // Not a global change, use standard processing
            debouncedGenerate();
        }
    }

    // Process global changes that won't affect manual tasks
    function processGlobalChangePreservingManualTasks(inputElement) {
        // Store manual tasks to preserve them
        const manualTasks = masterTaskList.filter(t => t.isManuallySet && !t.id.includes('freetask'));
        const manualTaskData = manualTasks.map(t => ({
            id: t.id,
            scheduledStartDate: new Date(t.scheduledStartDate),
            scheduledEndDate: new Date(t.scheduledEndDate),
            isManuallySet: t.isManuallySet,
            predecessors: t.predecessors ? [...t.predecessors] : []
        }));
        
        // Process the change normally
        processNormalGlobalChange(inputElement);
        
        // Restore manual task positions after regeneration
        setTimeout(() => {
            manualTaskData.forEach(manualData => {
                const task = masterTaskList.find(t => t.id === manualData.id);
                if (task) {
                    task.scheduledStartDate = manualData.scheduledStartDate;
                    task.scheduledEndDate = manualData.scheduledEndDate;
                    task.isManuallySet = manualData.isManuallySet;
                    task.isScheduled = true;
                }
            });
            calculateAndRender();
        }, 100);
    }

    // Process global changes with conflict detection
    function processGlobalChangeWithConflictDetection(inputElement) {
        const id = inputElement.id;
        
        if (id.startsWith('num-') || id.includes('shoot-days-per-ep') || 
            id.includes('shoot-day-overrides') || id.includes('num-shoot-blocks') || 
            id.startsWith('ep-studio-cuts-')) {
            if (id === 'num-editors') {
                updateBudgetForEditorCount();
            }
            if (id.startsWith('num-')) {
                generatePersonnelFields();
                generateStudioCutFields();
                generateBlockFields();
            }
            updateWrapDate();
            fullRegenerationWithConflictDetection();
            gridVisibleColumns = getCurrentAllGridColumns();
            renderGridView();
        } else {
            debouncedGenerateWithConflictDetection();
        }
    }

    // Add this new function to handle the link/unlink toggle changes
    function handleLinkUnlinkToggleChange() {
    const isLinkedMode = !unlinkToggle.checked; // unchecked means linked
    const tasksWithManualDates = masterTaskList.filter(t => t.manualStartDate && !t.isManuallySet);
    
    if (isLinkedMode && tasksWithManualDates.length > 0) {
        // Switching from unlinked to linked mode with existing unlinked tasks
        const message = `You have ${tasksWithManualDates.length} task(s) that were moved in UNLINKED mode. 
        
In LINKED mode, these tasks will be converted to fully manual positions and may affect the schedule.

Would you like to:
- "Convert" - Convert them to linked manual tasks (recommended)
- "Reset" - Reset them to automatic scheduling
- "Cancel" - Stay in unlinked mode`;

        const choice = prompt(message + "\n\nType: convert, reset, or cancel", "convert");
        
        if (choice === "cancel") {
            unlinkToggle.checked = true; // Stay in unlinked mode
            return;
        } else if (choice === "reset") {
            // Reset unlinked tasks to automatic scheduling
            tasksWithManualDates.forEach(task => {
                delete task.manualStartDate;
                task.isManuallySet = false;
                task.isScheduled = false;
                // Restore original predecessors
                if (task.originalPredecessors) {
                    task.predecessors = task.originalPredecessors.map(p => ({ ...p }));
                    delete task.originalPredecessors; // Clean up after restoration
                }
            });
            calculateAndRender();
        } else {
            // Convert to fully manual tasks (default)
            tasksWithManualDates.forEach(task => {
                task.isManuallySet = true;
                task.isScheduled = true;
                task.scheduledStartDate = task.manualStartDate;
                task.scheduledEndDate = addBusinessDays(task.manualStartDate, task.info.duration, task.info.department, task.epId, task.resources);
                task.predecessors = []; // Clear predecessors for manual tasks
                delete task.manualStartDate; // Remove the manual date property
            });
            calculateAndRender();
        }
    }
    
    // If switching to unlinked mode, no special handling needed
    // Manual tasks will keep their positions but can be rescheduled
}

    // Process normal global changes
    function processNormalGlobalChange(inputElement) {
        const id = inputElement.id;
        
        if (id.startsWith('num-') || id.includes('shoot-days-per-ep') || 
            id.includes('shoot-day-overrides') || id.includes('num-shoot-blocks') || 
            id.startsWith('ep-studio-cuts-')) {
            if (id === 'num-editors') {
                updateBudgetForEditorCount();
            }
            if (id.startsWith('num-')) {
                generatePersonnelFields();
                generateStudioCutFields();
                generateBlockFields();
            }
            updateWrapDate();
            fullRegeneration();
            gridVisibleColumns = getCurrentAllGridColumns();
            renderGridView();
        } else {
            debouncedGenerate();
        }
    }

    // Auto-populate show code from show name
    function autoPopulateShowCode(showName) {
        const words = showName.split(' ').filter(w => w.length > 0);
        const acronym = words.map(w => w[0]).join('').toUpperCase().slice(0, 4);
        document.getElementById('show-code').value = acronym;
    }

    document.getElementById('block-distribution-container').addEventListener('change', (e) => {
        if (e.target.matches('input[type="number"]')) {
            updateDirectorAssignmentsFromBlocks();
            calculateAndRender();
        }
    });

    document.getElementById('start-of-photography').addEventListener('change', calculateAndRender);
    document.getElementById('holiday-region-controls').addEventListener('change', calculateAndRender);

    function setupCollapsibleSections() {
        document.querySelectorAll('.collapsible-header').forEach(header => {
            header.addEventListener('click', () => {
                const content = header.nextElementSibling;
                const isExpanded = header.classList.toggle('expanded');
                content.classList.toggle('collapsed');

                const icon = header.querySelector('.collapsible-icon');
                if (icon) {
                    icon.textContent = isExpanded ? '−' : '+';
                }
            });
        });
    }

    // --- UI Field Generation ---
    function generateStudioCutFields() {
        const numEpisodes = parseInt(document.getElementById('num-episodes').value);
        const container = document.getElementById('studio-cuts-per-episode-container');
        container.innerHTML = '<h6># of Studio/Network Cuts Per EP</h6>';

        const defaultValue = scheduleType === 'half-hour' ? 2 : 3;
        for (let i = 0; i < numEpisodes; i++) {
            const epDefault = scheduleType === 'hour-long' && i === 0 ? 5 : defaultValue;
            const cutEntryHTML = `
                <div class="cut-entry">
                    <label for="ep-studio-cuts-${i}">EP ${i + 1}:</label>
                    <input type="number" id="ep-studio-cuts-${i}" value="${epDefault}" min="0">
                </div>`;
            container.insertAdjacentHTML('beforeend', cutEntryHTML);
            document.getElementById(`ep-studio-cuts-${i}`).addEventListener('input', (e) => {
                fullRegeneration();
                gridVisibleColumns = getCurrentAllGridColumns();
                renderGridView();
            });
        }
    }

    function updateDirectorAssignmentsFromBlocks() {
        const numEpisodes = parseInt(document.getElementById('num-episodes').value);
        const numBlocks = parseInt(document.getElementById('num-shoot-blocks').value);
        const numDirectors = parseInt(document.getElementById('num-directors').value);

        for (let i = 0; i < numDirectors; i++) {
            const directorSelect = document.getElementById(`director-eps-${i}`);
            if (directorSelect) {
                Array.from(directorSelect.options).forEach(opt => opt.selected = false);
            }
        }

        if (numBlocks === 1) {
            const epsPerDirector = Math.ceil(numEpisodes / numDirectors);
            let episodeStartIndex = 0;
            for (let i = 0; i < numDirectors; i++) {
                const directorSelect = document.getElementById(`director-eps-${i}`);
                if (!directorSelect) continue;
                const episodeEndIndex = Math.min(episodeStartIndex + epsPerDirector, numEpisodes);
                for (let j = episodeStartIndex; j < episodeEndIndex; j++) {
                    if (directorSelect.options[j]) {
                        directorSelect.options[j].selected = true;
                    }
                }
                episodeStartIndex = episodeEndIndex;
            }
        } else {
            let episodeCounter = 0;
            for (let i = 0; i < numBlocks; i++) {
                const blockEpsInput = document.getElementById(`block-eps-${i}`);
                if (!blockEpsInput) continue;

                const epsInBlock = parseInt(blockEpsInput.value);
                const directorIndex = i % numDirectors;
                const directorSelect = document.getElementById(`director-eps-${directorIndex}`);

                if (directorSelect) {
                    for (let j = 0; j < epsInBlock; j++) {
                        if (directorSelect.options[episodeCounter]) {
                            directorSelect.options[episodeCounter].selected = true;
                        }
                        episodeCounter++;
                    }
                }
            }
        }
    }

    function generateBlockFields() {
        const numEpisodes = parseInt(document.getElementById('num-episodes').value);
        const numBlocks = parseInt(document.getElementById('num-shoot-blocks').value);
        const numDirectors = parseInt(document.getElementById('num-directors').value);
        const blockContainer = document.getElementById('block-distribution-container');
        blockContainer.innerHTML = '';

        if (numBlocks === 1) {
            blockContainer.innerHTML = '<span>Shooting is Crossboarded</span>';
            updateDirectorAssignmentsFromBlocks();
            return;
        }
        if (numBlocks > numEpisodes) {
            document.getElementById('num-shoot-blocks').value = numEpisodes;
            generateBlockFields();
            return;
        }

        const directorNames = Array.from({length: numDirectors}, (_, i) => {
            const input = document.getElementById(`director-name-${i}`);
            return input ? input.value : `Director ${String.fromCharCode(88 + i)}`;
        });

        const baseEpsPerBlock = Math.floor(numEpisodes / numBlocks);
        let remainder = numEpisodes % numBlocks;

        for (let i = 0; i < numBlocks; i++) {
            const epsInBlock = baseEpsPerBlock + (remainder > 0 ? 1 : 0);
            if (remainder > 0) remainder--;

            const directorIndex = i % numDirectors;
            const directorName = directorNames[directorIndex];

            const blockHTML = `
                <div class="block-entry">
                    <label for="block-eps-${i}">Block ${i+1} EPs:</label>
                    <input type="number" id="block-eps-${i}" value="${epsInBlock}" min="1">
                    <span>(Dir: ${directorName})</span>
                </div>
            `;
            blockContainer.insertAdjacentHTML('beforeend', blockHTML);
        }
        updateDirectorAssignmentsFromBlocks();
    }

    function generatePersonnelFields() {
        const numEpisodes = parseInt(document.getElementById('num-episodes').value);
        const numEditors = parseInt(document.getElementById('num-editors').value);
        const numDirectors = parseInt(document.getElementById('num-directors').value);

        const editorsContainer = document.getElementById('editors-assignments');
        const directorsContainer = document.getElementById('directors-assignments');

        editorsContainer.innerHTML = '<h6>Editors</h6>';
        directorsContainer.innerHTML = '<h6>Directors</h6>';

        let episodeOptions = '';
        for (let i = 1; i <= numEpisodes; i++) {
            episodeOptions += `<option value="${i-1}">EP ${i}</option>`;
        }

        for (let i = 0; i < numEditors; i++) {
            const defaultName = `Editor ${String.fromCharCode(65 + i)}`;
            const editorHTML = `
                <div class="personnel-entry">
                    <label for="editor-name-${i}">Name</label>
                    <input type="text" id="editor-name-${i}" value="${defaultName}">
                    <label for="editor-eps-${i}">EPs</label>
                    <select id="editor-eps-${i}" multiple>${episodeOptions}</select>
                </div>`;
            editorsContainer.insertAdjacentHTML('beforeend', editorHTML);
        }
        for (let i = 0; i < numEditors; i++) {
            const select = document.getElementById(`editor-eps-${i}`);
            for (let j = 0; j < numEpisodes; j++) {
                if (j % numEditors === i) {
                    select.options[j].selected = true;
                }
            }
        }

        for (let i = 0; i < numDirectors; i++) {
            const defaultName = `Director ${String.fromCharCode(88 + i)}`;
            const directorHTML = `
                <div class="personnel-entry">
                    <label for="director-name-${i}">Name</label>
                    <input type="text" id="director-name-${i}" value="${defaultName}">
                    <label for="director-eps-${i}">EPs</label>
                    <select id="director-eps-${i}" multiple>${episodeOptions}</select>
                </div>`;
            directorsContainer.insertAdjacentHTML('beforeend', directorHTML);
        }
    }

    function generateHolidaySelectors() {
        const container = document.getElementById('holiday-region-controls');
        container.innerHTML = '';
        const regions = { 'US': 'United States', 'UK': 'United Kingdom', 'CA': 'Canada', 'AUS': 'Australia' };
        const departments = ['SHOOT', 'EDIT', 'MUSIC', 'VFX', 'PICTURE', 'SOUND', 'DELIVERY'];

        for (const regionCode in regions) {
            const regionName = regions[regionCode];
            let regionHTML = `<div class="holiday-region-group"><h6>${regionName}</h6>`;
            departments.forEach(dept => {
                const isChecked = regionCode === 'US' ? 'checked' : '';
                regionHTML += `
                    <div class="holiday-department-toggle">
                        <label for="holiday-${regionCode}-${dept}">${dept}</label>
                        <label class="toggle-switch">
                            <input type="checkbox" id="holiday-${regionCode}-${dept}" data-region="${regionCode}" data-department="${dept}" ${isChecked}>
                            <span class="slider"></span>
                        </label>
                    </div>
                `;
            });
            regionHTML += `</div>`;
            container.insertAdjacentHTML('beforeend', regionHTML);
        }
    }

    // --- DATE & CALENDAR UTILITIES ---
    const toYYYYMMDD = (d) => d.toISOString().slice(0, 10);

    function getNthDayOfMonth(n, dayOfWeek, month, year) {
        const dt = new Date(Date.UTC(year, month, 1));
        let count = 0;
        while (count < n) {
            if (dt.getUTCDay() === dayOfWeek) count++;
            if (count === n) break;
            dt.setUTCDate(dt.getUTCDate() + 1);
        }
        return dt;
    }

    function getLastDayOfMonth(dayOfWeek, month, year) {
        const dt = new Date(Date.UTC(year, month + 1, 0));
        while (dt.getUTCDay() !== dayOfWeek) {
            dt.setUTCDate(dt.getUTCDate() - 1);
        }
        return dt;
    }

    function getEaster(year) {
        const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
        return new Date(Date.UTC(year, month - 1, day));
    }

    function generateHolidays(startYear, numYears) {
        const holidays = { US: [], UK: [], CA: [], AUS: [] };
        for (let i = 0; i < numYears; i++) {
            const year = startYear + i;

            holidays.US.push({ date: toYYYYMMDD(new Date(Date.UTC(year, 0, 1))), name: "New Year's Day (US)" });
            holidays.US.push({ date: toYYYYMMDD(getNthDayOfMonth(3, 1, 0, year)), name: "MLK Day (US)" });
            holidays.US.push({ date: toYYYYMMDD(getNthDayOfMonth(3, 1, 1, year)), name: "Presidents' Day (US)" });
            holidays.US.push({ date: toYYYYMMDD(getLastDayOfMonth(1, 4, year)), name: "Memorial Day (US)" });
            holidays.US.push({ date: toYYYYMMDD(new Date(Date.UTC(year, 5, 19))), name: "Juneteenth (US)" });
            holidays.US.push({ date: toYYYYMMDD(new Date(Date.UTC(year, 6, 4))), name: "Independence Day (US)" });
            holidays.US.push({ date: toYYYYMMDD(getNthDayOfMonth(1, 1, 8, year)), name: "Labor Day (US)" });
            const thanksgiving = getNthDayOfMonth(4, 4, 10, year);
            holidays.US.push({ date: toYYYYMMDD(thanksgiving), name: "Thanksgiving (US)" });
            const dayAfterThanksgiving = new Date(thanksgiving);
            dayAfterThanksgiving.setUTCDate(thanksgiving.getUTCDate() + 1);
            holidays.US.push({ date: toYYYYMMDD(dayAfterThanksgiving), name: "Thanksgiving (US)" });
            holidays.US.push({ date: toYYYYMMDD(new Date(Date.UTC(year, 11, 25))), name: "Christmas Day (US)" });

            const easterUK = getEaster(year);
            holidays.UK.push({ date: toYYYYMMDD(new Date(Date.UTC(year, 0, 1))), name: "New Year's Day (UK)" });
            const goodFridayUK = new Date(easterUK); goodFridayUK.setUTCDate(easterUK.getUTCDate() - 2);
            holidays.UK.push({ date: toYYYYMMDD(goodFridayUK), name: "Good Friday (UK)" });
            const easterMondayUK = new Date(easterUK); easterMondayUK.setUTCDate(easterMondayUK.getUTCDate() + 1);
            holidays.UK.push({ date: toYYYYMMDD(easterMondayUK), name: "Easter Monday (UK)" });
            holidays.UK.push({ date: toYYYYMMDD(getNthDayOfMonth(1, 1, 4, year)), name: "Early May Bank Holiday (UK)" });
            holidays.UK.push({ date: toYYYYMMDD(getLastDayOfMonth(1, 4, year)), name: "Spring Bank Holiday (UK)" });
            holidays.UK.push({ date: toYYYYMMDD(getLastDayOfMonth(1, 7, year)), name: "Summer Bank Holiday (UK)" });
            holidays.UK.push({ date: toYYYYMMDD(new Date(Date.UTC(year, 11, 25))), name: "Christmas Day (UK)" });
            holidays.UK.push({ date: toYYYYMMDD(new Date(Date.UTC(year, 11, 26))), name: "Boxing Day (UK)" });

            const easterCA = getEaster(year);
            holidays.CA.push({ date: toYYYYMMDD(new Date(Date.UTC(year, 0, 1))), name: "New Year's Day (CA)" });
            const goodFridayCA = new Date(easterCA); goodFridayCA.setUTCDate(easterCA.getUTCDate() - 2);
            holidays.CA.push({ date: toYYYYMMDD(goodFridayCA), name: "Good Friday (CA)"});
            const victoriaDay = new Date(Date.UTC(year, 4, 25));
            while (victoriaDay.getUTCDay() !== 1) { victoriaDay.setUTCDate(victoriaDay.getUTCDate() - 1); }
            holidays.CA.push({ date: toYYYYMMDD(victoriaDay), name: "Victoria Day (CA)" });
            holidays.CA.push({ date: toYYYYMMDD(new Date(Date.UTC(year, 6, 1))), name: "Canada Day (CA)" });
            holidays.CA.push({ date: toYYYYMMDD(getNthDayOfMonth(1, 1, 7, year)), name: "Civic Holiday (CA)" });
            holidays.CA.push({ date: toYYYYMMDD(getNthDayOfMonth(1, 1, 8, year)), name: "Labour Day (CA)" });
            holidays.CA.push({ date: toYYYYMMDD(getNthDayOfMonth(2, 1, 9, year)), name: "Thanksgiving (CA)" });
            holidays.CA.push({ date: toYYYYMMDD(new Date(Date.UTC(year, 11, 25))), name: "Christmas Day (CA)" });
            holidays.CA.push({ date: toYYYYMMDD(new Date(Date.UTC(year, 11, 26))), name: "Boxing Day (CA)" });

            const easterAUS = getEaster(year);
            holidays.AUS.push({ date: toYYYYMMDD(new Date(Date.UTC(year, 0, 1))), name: "New Year's Day (AUS)" });
            holidays.AUS.push({ date: toYYYYMMDD(new Date(Date.UTC(year, 0, 26))), name: "Australia Day (AUS)" });
            const goodFridayAUS = new Date(easterAUS); goodFridayAUS.setUTCDate(easterAUS.getUTCDate() - 2);
            holidays.AUS.push({ date: toYYYYMMDD(goodFridayAUS), name: "Good Friday (AUS)" });
            const easterMondayAUS = new Date(easterAUS); easterMondayAUS.setUTCDate(easterMondayAUS.getUTCDate() + 1);
            holidays.AUS.push({ date: toYYYYMMDD(easterMondayAUS), name: "Easter Monday (AUS)" });
            holidays.AUS.push({ date: toYYYYMMDD(new Date(Date.UTC(year, 3, 25))), name: "Anzac Day (AUS)" });
            holidays.AUS.push({ date: toYYYYMMDD(getNthDayOfMonth(2, 1, 5, year)), name: "Queen's Birthday (AUS)" });
            holidays.AUS.push({ date: toYYYYMMDD(new Date(Date.UTC(year, 11, 25))), name: "Christmas Day (AUS)" });
            holidays.AUS.push({ date: toYYYYMMDD(new Date(Date.UTC(year, 11, 26))), name: "Boxing Day (AUS)" });
        }
        return holidays;
    }

    const regionalHolidays = generateHolidays(new Date().getFullYear() - 1, 20);

    function getHolidayForDate(date, department) {
        const dateString = date.toISOString().slice(0, 10);
        const activeRegions = [];
        document.querySelectorAll(`#holiday-region-controls input[data-department="${department}"]:checked`).forEach(toggle => {
            activeRegions.push(toggle.dataset.region);
        });

        for (const region of activeRegions) {
            const holiday = regionalHolidays[region].find(h => h.date === dateString);
            if (holiday) return holiday;
        }
        return null;
    }

    function isBusinessDay(date, department, epId = null, resources = []) {
        const dateString = toYYYYMMDD(date);
        const dayOfWeek = date.getUTCDay();

        const sixthDayAuths = sixthDayWorkDates.filter(d => d.date === dateString);
        if (sixthDayAuths.length > 0) {
            for(const auth of sixthDayAuths) {
                if (auth.scope === 'all') return true;
                if (epId !== null && auth.scope === 'episode' && auth.value == epId) return true;
                if (resources.length > 0 && auth.scope === 'resource' && resources.includes(auth.value)) return true;
            }
        }

        if (dayOfWeek === 0 || dayOfWeek === 6) return false;

        if (getHolidayForDate(date, department)) return false;

        for(const hiatus of hiatuses) {
            const start = new Date(hiatus.start + 'T12:00:00Z');
            const end = new Date(hiatus.end + 'T12:00:00Z');
            if (date >= start && date <= end) {
                return false;
            }
        }

        return true;
    }
    
    function countBusinessDays(startDate, endDate, department, epId = null, resources = []) {
        let count = 0;
        let currentDate = new Date(startDate.getTime());
        while (currentDate < endDate) {
            if (isBusinessDay(currentDate, department, epId, resources)) {
                count++;
            }
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }
        return count;
    }


    function findNextBusinessDay(date, department, epId = null, resources = []) {
        let nextDay = new Date(date.getTime());
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
        while (!isBusinessDay(nextDay, department, epId, resources)) {
            nextDay.setUTCDate(nextDay.getUTCDate() + 1);
        }
        return nextDay;
    }

    function subtractBusinessDays(startDate, duration, department, epId = null, resources = []) {
        let endDate = new Date(startDate.getTime());
        let daysSubtracted = 0;
        while (daysSubtracted < duration) {
            endDate.setUTCDate(endDate.getUTCDate() - 1);
            if (isBusinessDay(endDate, department, epId, resources)) {
                daysSubtracted++;
            }
        }
        return endDate;
    }

    function addBusinessDays(startDate, duration, department, epId = null, resources = []) {
        if (!(startDate instanceof Date) || isNaN(startDate.getTime())) {
            const parsedDate = new Date(startDate);
            if (isNaN(parsedDate.getTime())) {
                console.error("Invalid start date provided to addBusinessDays:", startDate);
                return null;
            }
            startDate = parsedDate;
        }

        let endDate = new Date(startDate.getTime());

        let currentDay = new Date(startDate.getTime());
        while (!isBusinessDay(currentDay, department, epId, resources)) {
            currentDay.setUTCDate(currentDay.getUTCDate() + 1);
        }

        let daysAdded = 0;
        endDate = currentDay;
        if (duration > 1) {
            while (daysAdded < duration - 1) {
                endDate.setUTCDate(endDate.getUTCDate() + 1);
                if (isBusinessDay(endDate, department, epId, resources)) {
                    daysAdded++;
                }
            }
        }
        return endDate;
    }
    
    function addBusinessDaysWithOffset(startDate, offset, department, epId = null, resources = []) {
        let newDate = new Date(startDate.getTime());
        let daysMoved = 0;
        const direction = offset > 0 ? 1 : -1;
    
        while (daysMoved < Math.abs(offset)) {
            newDate.setUTCDate(newDate.getUTCDate() + direction);
            if (isBusinessDay(newDate, department, epId, resources)) {
                daysMoved++;
            }
        }
        return newDate;
    }


    function updateWrapDate() {
        const startDateInput = document.getElementById('start-of-photography');
        const startDateValue = startDateInput.value;
        if (!startDateValue) return;

        const shootingBlocks = getShootingBlocks();
        if(shootingBlocks.length === 0) return;

        const lastBlock = shootingBlocks[shootingBlocks.length-1];
        if (!lastBlock || !lastBlock.endDate) {
            document.getElementById('wrap-of-photography').value = '';
        } else {
            const wrapDateString = lastBlock.endDate.toISOString().slice(0, 10);
            document.getElementById('wrap-of-photography').value = wrapDateString;
        }

        const numEpisodes = parseInt(document.getElementById('num-episodes').value);
        const defaultShootDaysPerEp = parseInt(document.getElementById('shoot-days-per-ep').value);
        const shootDayOverrides = getShootDayOverrides();
        let totalShootDays = 0;
        for (let i = 0; i < numEpisodes; i++) {
        totalShootDays += shootDayOverrides[i] !== undefined ? shootDayOverrides[i] : defaultShootDaysPerEp;
        }

        if (!isNaN(totalShootDays)) {
        document.getElementById('total-shoot-days-display').textContent = totalShootDays;
        } else {
            document.getElementById('total-shoot-days-display').textContent = '-';
        }
    }

    function getDirectorAssignments() {
        const assignments = {};
        const numDirectors = parseInt(document.getElementById('num-directors').value);
        for (let i = 0; i < numDirectors; i++) {
            const directorNameInput = document.getElementById(`director-name-${i}`);
            if (!directorNameInput) continue;
            const directorName = directorNameInput.value;
            const directorSelect = document.getElementById(`director-eps-${i}`);
            if (directorSelect) {
                const assignedEps = Array.from(directorSelect.selectedOptions).map(opt => opt.value);
                assignedEps.forEach(epId => {
                    assignments[epId] = directorName;
                });
            }
        }
        return assignments;
    }

    function generateScheduleFromScratch() {
        episodesData = Array.from({ length: parseInt(document.getElementById('num-episodes').value) }, (v, i) => ({
            tasks: [], editors: [], director: null
        }));

        const directorAssignments = getDirectorAssignments();
        for(let i = 0; i < episodesData.length; i++) episodesData[i].director = directorAssignments[i];

        const numEditors = parseInt(document.getElementById('num-editors').value);
        for (let i = 0; i < numEditors; i++) {
            const editorName = document.getElementById(`editor-name-${i}`)?.value;
            const editorSelect = document.getElementById(`editor-eps-${i}`);
            if (editorSelect) {
                const assignedEps = Array.from(editorSelect.selectedOptions).map(opt => parseInt(opt.value));
                assignedEps.forEach(epId => {
                    if(episodesData[epId]) {
                        episodesData[epId].editors.push(editorName);
                    }
                });
            }
        }

        const editorsCutDays = parseInt(document.getElementById('editors-cut-days').value);
        const directorsCutDays = parseInt(document.getElementById('directors-cut-days').value);
        const producersCutDays = parseInt(document.getElementById('producers-cut-days').value);
        const studioNotesDays = parseInt(document.getElementById('studio-notes-days').value);
        const networkCutDays = parseInt(document.getElementById('network-cut-days').value);
        const pictureLockDays = parseInt(document.getElementById('picture-lock-days').value);
        const finishingPeriodWeeks = parseInt(document.getElementById('finishing-period-weeks').value);

        const onlineDays = parseInt(document.getElementById('online-days').value);
        const colorGradeDays = parseInt(document.getElementById('color-grade-days').value);
        const preMixDays = parseInt(document.getElementById('pre-mix-days').value);
        const finalMixDays = parseInt(document.getElementById('final-mix-days').value);
        const mixReviewDays = parseInt(document.getElementById('mix-review-days').value);
        const finalMixFixesDays = parseInt(document.getElementById('final-mix-fixes-days').value);

        for (let i = 0; i < episodesData.length; i++) {
            let currentEpisodeTasks = [];
            const create = (name, duration, department, predecessors = [], visible = true, priority = 50) => {
                const task = {
                    id: `ep${i}-task${currentEpisodeTasks.length}`, epId: i,
                    info: { name, duration, department, visible, priority, resourceRoles: [] },
                    predecessors: predecessors.map(p => ({ task: p, delay: 0 })),
                    resources: [], isScheduled: false, isManuallySet: false
                };
                if (department === 'PICTURE') task.resources.push(`Colorist`);
                else if (department === 'SOUND') task.resources.push(['M&E', 'M&E Delivery'].includes(name) ? 'M&E_Mixer' : 'Mixer');
                else if (department === 'EDIT' && episodesData[i].editors) {
                    task.resources.push(...episodesData[i].editors);
                }
                if (["Director's Cut", "Director's Cut v2", "Producer Notes"].includes(name)) task.resources.push(episodesData[i].director);

                task.originalPredecessors = predecessors.map(p => ({ task: p, delay: 0 }));
                currentEpisodeTasks.push(task);
                return task;
            };

            const editorsCut = create("Editor's Cut", editorsCutDays, 'EDIT', [], true, 2);
            const directorsCut = create("Director's Cut", i === 0 ? directorsCutDays + 1 : directorsCutDays, 'EDIT', [editorsCut], true, 1);
            const producerNotes = create("Producer Notes", 1, 'EDIT', [directorsCut], true, 1.1);
            const directorsCutV2 = create("Director's Cut v2", 1, 'EDIT', [producerNotes], true, 1.2);
            const producersCut = create("Producer's Cut", producersCutDays, 'EDIT', [directorsCutV2], true, 3);
            let lastTask = producersCut;
            const numStudioCutsForEpisode = parseInt(document.getElementById(`ep-studio-cuts-${i}`).value);
            for(let j = 1; j <= numStudioCutsForEpisode; j++) {
                const studioNotes = create("Notes", studioNotesDays, 'EDIT', [lastTask], true, 4 + j);
                const studioCut = create(`Studio/Network Cut #${j}`, networkCutDays, 'EDIT', [studioNotes], true, 4.1 + j);
                lastTask = studioCut;
            }
            const pictureLock = create("Picture Lock", pictureLockDays, 'EDIT', [lastTask], true, 99);
            const turnoverDelay = create("Turnover Delay", 4, 'DELAY', [pictureLock], false);
            const turnovers = create("Turnovers", 1, 'VFX', [turnoverDelay], true);
            const finishingDelay = create("Finishing Period Delay", (finishingPeriodWeeks * 5) -1, 'DELAY', [pictureLock], false);
            const vfxDue = create("VFX Due", 1, 'VFX', [finishingDelay], true);
            const onlineConformDelay = create("Online Conform Delay", 2, 'DELAY', [vfxDue], false);
            const onlineConform = create("Online Conform", onlineDays, 'PICTURE', [onlineConformDelay], true);
            const colorGrade = create("Color Grade", colorGradeDays, 'PICTURE', [onlineConform], true);
            const colorReview = create("Color Review", 1, 'PICTURE', [colorGrade], true);
            const finalColorGrade = create("Final Color Grade", 1, 'PICTURE', [colorReview], true);
            const colorGradeAnchor = create("Color Grade Anchor", 2, 'DELAY', [onlineConform], false);
            const preMix = create("Pre-Mix", preMixDays, 'SOUND', [colorGradeAnchor], true);
            const finalMix = create("Final Mix", finalMixDays, 'SOUND', [preMix, colorReview], true);
            const mixReview = create("Mix Review", mixReviewDays, 'SOUND', [finalMix], true);
            const finalMixFix = create("Final Mix Fix", finalMixFixesDays, 'SOUND', [mixReview], true);
            const mAndE = create("M&E", 1, 'SOUND', [finalMixFix], true);
            const mAndEDelivery = create("M&E Delivery", 1, 'SOUND', [mAndE], true);
            const qcDelivery = create("Deliver to QC v1", 1, 'DELIVERY', [mAndEDelivery], true);
            const finalDeliveryDelay = create("Final Delivery Delay", 14, 'DELAY', [qcDelivery], false);
            const finalDelivery = create("Final Delivery", 1, 'DELIVERY', [finalDeliveryDelay], true);

            masterTaskList.push(...currentEpisodeTasks);
        }
    }

    // Enhanced calculateSchedule function to better handle manually set tasks during global changes
    function calculateSchedule() {
    const producersCutsOverlap = document.getElementById('producers-cuts-overlap').checked;
    const producersCutsPreWrap = document.getElementById('producers-cuts-pre-wrap').checked;

    // Store manually set tasks and validate their state
    const manuallySetTasks = masterTaskList.filter(t => t.isManuallySet);
    const manualTaskRelationships = new Map();
    
    // Store manual task states to prevent cascade corruption
    const manualTaskStates = new Map();
    masterTaskList.filter(t => t.isManuallySet && !t.id.includes('freetask')).forEach(task => {
    manualTaskStates.set(task.id, {
        startDate: task.scheduledStartDate ? new Date(task.scheduledStartDate) : null,
        endDate: task.scheduledEndDate ? new Date(task.scheduledEndDate) : null,
        isScheduled: task.isScheduled,
        originalPredecessors: task.originalPredecessors ? [...task.originalPredecessors] : null
        });
    });

    manuallySetTasks.forEach(task => {
        // Ensure manually set tasks maintain their dates and scheduled state
        if (task.scheduledStartDate && task.scheduledEndDate) {
            task.isScheduled = true;
        }
        
        // Store which tasks depend on this manual task
        const dependents = masterTaskList.filter(t => 
            t.predecessors && t.predecessors.some(p => p.task && p.task.id === task.id)
        );
        manualTaskRelationships.set(task.id, dependents);
    });

    // Only reset non-manually set tasks
    masterTaskList.forEach(task => {
        if (!task.isManuallySet) {
            task.isScheduled = false;
            // Restore original predecessors for non-manual tasks only
            if (task.originalPredecessors) {
                task.predecessors = task.originalPredecessors.map(p => ({ ...p }));
            }
        }
    });
    
    // Clear episode tasks to rebuild
    episodesData.forEach(ep => ep.tasks = []);

    // Rest of the calculateSchedule function remains the same...
    const directorAssignments = getDirectorAssignments();
    const shootingBlocks = getShootingBlocks();
    shootingBlocks.forEach(block => {
        const directorName = directorAssignments[block.episodes[0]];
        block.director = directorName;
        block.episodes.forEach(epId => {
            if(episodesData[epId]) episodesData[epId].blockWrapDate = block.endDate;
        });
    });
    
    // Apply sequential lock logic only to non-manually set tasks
    if(enforceSequentialLock){
        const allPictureLocks = masterTaskList.filter(t => t.info.name === "Picture Lock").sort((a,b) => a.epId - b.epId);
        for(let i=1; i < allPictureLocks.length; i++){
            if (!allPictureLocks[i].isManuallySet) {
                allPictureLocks[i].predecessors.push({task: allPictureLocks[i-1], delay: 0});
            }
        }
    }
    
    // Apply other scheduling logic (online conforms, producer's cuts, etc.)
    const allOnlineConforms = masterTaskList.filter(t => t.info.name === "Online Conform").sort((a,b) => a.epId - b.epId);
    const allFinalColorGrades = masterTaskList.filter(t => t.info.name === "Final Color Grade").sort((a,b) => a.epId - b.epId);
    for(let i=1; i < allOnlineConforms.length; i++){
        const currentConform = allOnlineConforms[i];
        const prevFinalColor = allFinalColorGrades[i-1];
        if (currentConform && prevFinalColor && !currentConform.isManuallySet) {
            currentConform.predecessors.push({task: prevFinalColor, delay: 0});
        }
    }

    const finalWrapDate = shootingBlocks.length > 0 ? new Date(Math.max(...shootingBlocks.map(b => b.endDate.getTime()))) : new Date();
    const shootWrapAnchor = { id: 'shoot-wrap-anchor', isScheduled: true, scheduledEndDate: finalWrapDate };
    
    const allProducersCuts = masterTaskList.filter(t => t.info.name === "Producer's Cut").sort((a, b) => a.epId - b.epId);
    for (let i = 0; i < allProducersCuts.length; i++) {
        if(!allProducersCuts[i].isManuallySet) {
            if (!producersCutsPreWrap && i === 0) {
                allProducersCuts[i].predecessors.push({task: shootWrapAnchor, delay: 0});
            }
            if (i > 0) {
                const overlapDays = producersCutsOverlap ? Math.floor(allProducersCuts[i-1].info.duration / 2) : 0;
                allProducersCuts[i].predecessors.push({task: allProducersCuts[i-1], delay: -overlapDays});
            }
        }
    }
    
    // Continue with director sequencing logic
    const episodeShootOrder = shootingBlocks.flatMap(block => block.episodes);
    const uniqueDirectors = [...new Set(Object.values(directorAssignments))];
    uniqueDirectors.forEach(directorName => {
        const directorEpsInShootOrder = episodeShootOrder.filter(epId => directorAssignments[epId] === directorName);
        for (let i = 1; i < directorEpsInShootOrder.length; i++) {
            const prevEpId = directorEpsInShootOrder[i - 1];
            const currentEpId = directorEpsInShootOrder[i];
            const prevDCv2 = masterTaskList.find(t => t.epId === prevEpId && t.info.name === "Director's Cut v2");
            const currentDC = masterTaskList.find(t => t.epId === currentEpId && t.info.name === "Director's Cut");
            if (prevDCv2 && currentDC && !currentDC.isManuallySet) {
                currentDC.predecessors.push({ task: prevDCv2, delay: 0 });
            }
        }
    });

    // Rest of the scheduling algorithm remains the same...
    let personnelAvailability = {};
    const allPersonnel = new Set();
    masterTaskList.forEach(task => task.resources.forEach(r => r && allPersonnel.add(r)));
    allPersonnel.forEach(p => personnelAvailability[p] = new Date('1970-01-01'));
    
    // Pre-block personnel for manually set tasks
    masterTaskList.filter(t => t.isManuallySet && t.isScheduled).forEach(task => {
        task.resources.forEach(resource => {
            if (resource) {
                personnelAvailability[resource] = findNextBusinessDay(task.scheduledEndDate, task.info.department, task.epId, task.resources);
            }
        });
    });

    let scheduledCount = masterTaskList.filter(t => t.isScheduled).length;
    let safetyBreak = 0;
    
    while (scheduledCount < masterTaskList.length) {
        if (++safetyBreak > masterTaskList.length * 200) {
            console.error("Scheduling loop terminated for safety."); 
            break; 
        }
        
        let availableTasks = masterTaskList.filter(t => !t.isScheduled && t.predecessors.every(p => p.task && p.task.isScheduled));
        if (availableTasks.length === 0) {
            if(masterTaskList.some(t => !t.isScheduled)) {
                console.error("Scheduling failed. Circular dependency likely.", masterTaskList.filter(t=>!t.isScheduled));
            }
            break;
        }
        
        // Continue with the rest of the scheduling logic...
        availableTasks.forEach(task => {
            let dependencyStartDate = new Date('1970-01-01');
            if (task.predecessors.length > 0) {
                const endDates = task.predecessors.map(p => {
                    const predEndDate = new Date(p.task.scheduledEndDate.getTime());
                    if (p.delay < 0) {
                        return subtractBusinessDays(predEndDate, -p.delay, task.info.department, task.epId, task.resources);
                    }
                    return p.delay > 0 ? addBusinessDays(predEndDate, p.delay, task.info.department, task.epId, task.resources) : predEndDate;
                });
                dependencyStartDate = findNextBusinessDay(new Date(Math.max(...endDates.map(d => d.getTime()))), task.info.department, task.epId, task.resources);
            } else if (task.info.name === "Editor's Cut" && episodesData[task.epId].blockWrapDate) {
                dependencyStartDate = findNextBusinessDay(episodesData[task.epId].blockWrapDate, task.info.department, task.epId, task.resources);
            }

            let resourceStartDate = new Date('1970-01-01');
            if (task.resources.length > 0) {
                const resourceAvailDates = task.resources.filter(r => r).map(resourceName => {
                    let availableFrom = personnelAvailability[resourceName] ? new Date(personnelAvailability[resourceName].getTime()) : new Date('1970-01-01');
                    const directorShootBlocks = shootingBlocks.filter(b => b.director === resourceName);
                    if (directorShootBlocks.length > 0) {
                        let isBlocked = true;
                        while (isBlocked) {
                            isBlocked = false;
                            for (const block of directorShootBlocks) {
                                const taskEndDate = addBusinessDays(availableFrom, task.info.duration, task.info.department, task.epId, task.resources);
                                if (Math.max(availableFrom.getTime(), block.startDate.getTime()) < Math.min(taskEndDate.getTime(), block.endDate.getTime())) {
                                    availableFrom = findNextBusinessDay(block.endDate, task.info.department, task.epId, task.resources);
                                    isBlocked = true; 
                                    break; 
                                }
                            }
                        }
                    }
                    return availableFrom.getTime();
                });
                if(resourceAvailDates.length > 0) {
                    resourceStartDate = new Date(Math.max(...resourceAvailDates));
                }
            }
            
            let baseStart = Math.max(dependencyStartDate.getTime(), resourceStartDate.getTime());

// ENHANCED: Handle manual start dates from unlinked mode
if (task.manualStartDate instanceof Date && !isNaN(task.manualStartDate.getTime())) {
    // In unlinked mode, respect the manual date but also consider dependencies
    if (task.isManuallySet) {
        // If it's fully manual, use the manual date exactly
        baseStart = task.manualStartDate.getTime();
    } else {
        // If it's unlinked manual, use the later of manual date or dependencies
        baseStart = Math.max(baseStart, task.manualStartDate.getTime());
    }
}

task.potentialStartDate = new Date(baseStart);
        });
        
        availableTasks.sort((a, b) => a.potentialStartDate - b.potentialStartDate || a.info.priority - b.info.priority || a.epId - b.epId);

        const taskToSchedule = availableTasks[0];
        if (!taskToSchedule) break;

        let effectiveStartDate = new Date(taskToSchedule.potentialStartDate.getTime());
        while (!isBusinessDay(effectiveStartDate, taskToSchedule.info.department, taskToSchedule.epId, taskToSchedule.resources)) {
            effectiveStartDate.setUTCDate(effectiveStartDate.getUTCDate() + 1);
        }

        taskToSchedule.scheduledStartDate = effectiveStartDate;
        taskToSchedule.scheduledEndDate = addBusinessDays(taskToSchedule.scheduledStartDate, taskToSchedule.info.duration, taskToSchedule.info.department, taskToSchedule.epId, taskToSchedule.resources);
        taskToSchedule.isScheduled = true;
        scheduledCount++;

        if (taskToSchedule.manualStartDate) {
            delete taskToSchedule.manualStartDate;
        }

        taskToSchedule.resources.forEach(resource => {
            if (resource) personnelAvailability[resource] = findNextBusinessDay(taskToSchedule.scheduledEndDate, taskToSchedule.info.department, taskToSchedule.epId, taskToSchedule.resources);
        });
    }
    
    masterTaskList.forEach(task => { 
        if(task.isScheduled) episodesData[task.epId].tasks.push(task); 
    });
    calculateReleaseDates();
    
    // Final validation that manual anchors are still respected
    validateManualAnchors(manuallySetTasks);
    // Restore manual task states to ensure they maintain their positions
manualTaskStates.forEach((state, taskId) => {
    const task = masterTaskList.find(t => t.id === taskId);
    if (task && state.startDate) {
        task.scheduledStartDate = state.startDate;
        task.scheduledEndDate = state.endDate;
        task.isScheduled = state.isScheduled;
        task.isManuallySet = true;
        if (state.originalPredecessors) {
            task.originalPredecessors = state.originalPredecessors;
        }
        // Ensure predecessors are cleared for manually set tasks
        task.predecessors = [];
    }
});

}

    function calculateReleaseDates() {
        masterTaskList = masterTaskList.filter(t => t.info.name !== "Earliest Possible Release");

        const daysToAirValue = parseInt(document.getElementById('days-to-air').value);
        if (isNaN(daysToAirValue)) return;

        const airUnit = document.getElementById('air-unit').value;
        const daysToAdd = airUnit === 'weeks' ? daysToAirValue * 7 : daysToAirValue;
        const weekInMillis = 7 * 24 * 60 * 60 * 1000;

        const qcTasks = masterTaskList.filter(t => t.info.name === "Deliver to QC v1").sort((a,b) => a.epId - b.epId);
        if(qcTasks.length === 0) return;

        let initialReleaseDates = qcTasks.map(qcTask => {
            const releaseDate = new Date(qcTask.scheduledEndDate.getTime());
            releaseDate.setUTCDate(releaseDate.getUTCDate() + daysToAdd);
            return { epId: qcTask.epId, date: releaseDate };
        });

        for(let i = initialReleaseDates.length - 2; i >= 0; i--) {
            const currentRelease = initialReleaseDates[i];
            const nextRelease = initialReleaseDates[i+1];
            if ((nextRelease.date.getTime() - currentRelease.date.getTime()) > weekInMillis) {
                const newDate = new Date(nextRelease.date.getTime() - weekInMillis);
                currentRelease.date = newDate;
            }
        }

        initialReleaseDates.forEach(releaseInfo => {
            const releaseTask = {
                id: `ep${releaseInfo.epId}-release`,
                epId: releaseInfo.epId,
                info: { name: "Earliest Possible Release", duration: 1, department: 'DELIVERY', visible: true },
                predecessors: [],
                originalPredecessors: [],
                resources: [],
                isScheduled: true,
                isManuallySet: false,
                scheduledStartDate: releaseInfo.date,
                scheduledEndDate: releaseInfo.date
            };
            masterTaskList.push(releaseTask);
            episodesData[releaseInfo.epId].tasks.push(releaseTask);
        });
    }

    // --- RENDERING FUNCTIONS ---
    function checkForConflicts() {
        const personnelCommitments = {};
        const shootingBlocks = getShootingBlocks();

        masterTaskList.forEach(task => task.hasConflict = false);
        shootingBlocks.forEach(block => block.hasConflict = false);

        masterTaskList.forEach(task => {
            if (!task.isScheduled) return;
            task.resources.forEach(resource => {
                if (resource) {
                    if (!personnelCommitments[resource]) personnelCommitments[resource] = [];
                    personnelCommitments[resource].push({
                        id: task.id, type: 'task', startDate: task.scheduledStartDate,
                        endDate: task.scheduledEndDate, sourceObject: task
                    });
                }
            });
        });

        shootingBlocks.forEach(block => {
            if (block.director) {
                if (!personnelCommitments[block.director]) personnelCommitments[block.director] = [];
                personnelCommitments[block.director].push({
                    id: `block-${block.blockIndex}`, type: 'shoot', startDate: block.startDate,
                    endDate: block.endDate, sourceObject: block
                });
            }
        });

        for (const person in personnelCommitments) {
            const commitments = personnelCommitments[person].sort((a, b) => a.startDate - b.startDate);

            for (let i = 0; i < commitments.length - 1; i++) {
                const currentCommitment = commitments[i];
                const nextCommitment = commitments[i+1];

                if (currentCommitment.endDate >= nextCommitment.startDate) {
                    currentCommitment.sourceObject.hasConflict = true;
                    nextCommitment.sourceObject.hasConflict = true;
                }
            }
        }
    }


    function renderGanttChart() {
        checkForConflicts();
        const container = document.getElementById('gantt-container');
        container.innerHTML = '';

        const startOfPhotography = new Date(document.getElementById('start-of-photography').value + 'T12:00:00Z');

        let chartStartDate = new Date(startOfPhotography.getTime());
        chartStartDate.setUTCDate(chartStartDate.getUTCDate() - 7);

        let earliestTaskDate = new Date('2999-01-01');
        let latestTaskDate = new Date('1970-01-01');
        masterTaskList.forEach(t => {
            if (t.isScheduled && t.info.visible && t.scheduledStartDate < earliestTaskDate) earliestTaskDate = t.scheduledStartDate;
            if (t.isScheduled && t.info.visible && t.scheduledEndDate > latestTaskDate) latestTaskDate = t.scheduledEndDate;
        });
        const shootingBlocksForDate = getShootingBlocks();
        shootingBlocksForDate.forEach(block => {
            if (block.endDate > latestTaskDate) latestTaskDate = block.endDate;
        });

        overallMinDate = (earliestTaskDate < chartStartDate && earliestTaskDate.getFullYear() > 1970) ? earliestTaskDate : chartStartDate;

        if (latestTaskDate < overallMinDate || latestTaskDate.getFullYear() < 1971) {
            overallMaxDate = new Date(overallMinDate.getTime());
            overallMaxDate.setUTCMonth(overallMaxDate.getUTCMonth() + 6);
        } else {
            overallMaxDate = new Date(latestTaskDate.getTime());
            overallMaxDate.setUTCDate(overallMaxDate.getUTCDate() + 7);
        }

        const days = [];
        if (!overallMinDate || !overallMaxDate || isNaN(overallMinDate.getTime()) || isNaN(overallMaxDate.getTime()) || overallMinDate > overallMaxDate) return;

        let currentDate = new Date(Date.UTC(overallMinDate.getUTCFullYear(), overallMinDate.getUTCMonth(), overallMinDate.getUTCDate()));
        const lastDate = new Date(Date.UTC(overallMaxDate.getUTCFullYear(), overallMaxDate.getUTCMonth(), overallMaxDate.getUTCDate()));
        while (currentDate <= lastDate) {
            days.push(new Date(currentDate));
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }

        const chart = document.createElement('div');
        chart.className = 'gantt-chart';
        const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
        const monthHeaders = {};
        const weekHeaders = {};

        let currentWeekKey = null;
        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

        days.forEach((d) => {
            const monthYear = `${monthNames[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
            if (!monthHeaders[monthYear]) monthHeaders[monthYear] = 0;
            monthHeaders[monthYear]++;

            if (d.getUTCDay() === 0) { // Sunday
                const weekStartDateStr = d.toISOString().slice(0, 10);
                currentWeekKey = `week-${weekStartDateStr}`;
                weekHeaders[currentWeekKey] = { count: 0 };
            }
            if (!currentWeekKey) { // Handle case where chart doesn't start on a Sunday
                const weekStartDateStr = days[0].toISOString().slice(0, 10);
                currentWeekKey = `week-${weekStartDateStr}`;
                weekHeaders[currentWeekKey] = { count: 0 };
            }

            if (weekHeaders[currentWeekKey]) {
                weekHeaders[currentWeekKey].count++;
            }
        });

        const finalWeekHeaders = {};
        let shootWeekNum = 1;
        let postWeekNum = 1;
        const shootingBlocks = getShootingBlocks();
        const wrapOfPhotography = shootingBlocks.length > 0 ? shootingBlocks[shootingBlocks.length-1].endDate : null;

        let finalShootWeekStartDate = null;
        if (wrapOfPhotography) {
            finalShootWeekStartDate = new Date(wrapOfPhotography.getTime());
            finalShootWeekStartDate.setUTCDate(finalShootWeekStartDate.getUTCDate() - finalShootWeekStartDate.getUTCDay());
        }

        for(const key in weekHeaders){
            const week = weekHeaders[key];
            const weekStartDate = new Date(key.replace('week-', '') + 'T12:00:00Z');

            let label;

            if (weekStartDate < startOfPhotography) {
                label = 'Pre-Prod';
            } else if (finalShootWeekStartDate && weekStartDate > finalShootWeekStartDate) {
                label = `Post Week ${postWeekNum++}`;
            } else {
                label = `Shoot Week ${shootWeekNum++}`;
            }

            const lastLabel = Object.keys(finalWeekHeaders).pop();
            if (lastLabel === label) {
                 finalWeekHeaders[label] += week.count;
            } else {
                 finalWeekHeaders[label] = week.count;
            }
        }

        const getDayClasses = (d, department, epId = null, resources = []) => {
            let classes = [];
            const dateString = toYYYYMMDD(d);
            const month = d.getUTCMonth();
            const day = d.getUTCDate();

            if ((month === 2 && day === 31) || (month === 5 && day === 30) || (month === 8 && day === 30) || (month === 11 && day === 31)) {
                classes.push('quarter-end');
            }

            const sixthDayAuths = sixthDayWorkDates.filter(auth => auth.date === dateString);
            let isWorkDay = false;
            if (sixthDayAuths.length > 0) {
                for(const auth of sixthDayAuths) {
                    if (auth.scope === 'all' ||
                        (epId !== null && auth.scope === 'episode' && auth.value == epId) ||
                        (resources.length > 0 && auth.scope === 'resource' && resources.includes(auth.value))) {
                        classes.push('sixth-work-day');
                        isWorkDay = true;
                        break;
                    }
                }
            }

            if (!isWorkDay) {
                let isHiatus = false;
                for (const hiatus of hiatuses) {
                    const start = new Date(hiatus.start + 'T12:00:00Z');
                    const end = new Date(hiatus.end + 'T12:00:00Z');
                    if (d >= start && d <= end) {
                        isHiatus = true;
                        break;
                    }
                }
                if (isHiatus) {
                    classes.push('hiatus-day');
                } else if (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
                    classes.push('non-work-day');
                } else if (getHolidayForDate(d, department)) {
                    classes.push('hiatus-day');
                }
            }
            return classes.join(' ');
        };

        const rowNames = ['Shoot', 'EDIT', 'MUSIC', 'VFX', 'PICTURE', 'SOUND', 'DELIVERY'];

        let ganttBodyHTML = '';
        episodesData.forEach((ep, epId) => {
            let episodeHeaderTimelineHTML = `<div class="episode-header-timeline" style="grid-template-columns: repeat(${days.length}, var(--day-column-width));">`;
            const processedHolidays = new Set();
            days.forEach((d, i) => {
                const holiday = getHolidayForDate(d, 'EDIT');
                if (holiday && holiday.name && !processedHolidays.has(holiday.name)) {

                    let firstDayIndex = i;
                    let lastDayIndex = i;
                    if(i > 0 && getHolidayForDate(days[i-1], 'EDIT')?.name === holiday.name) {
                    } else {
                        for(let j = i + 1; j < days.length; j++) {
                            const nextDayHoliday = getHolidayForDate(days[j], 'EDIT');
                            if(nextDayHoliday && nextDayHoliday.name === holiday.name) {
                                lastDayIndex = j;
                            } else {
                                break;
                            }
                        }
                        episodeHeaderTimelineHTML += `<div class="header-holiday-marker" style="grid-column: ${firstDayIndex + 1} / span ${lastDayIndex - firstDayIndex + 1};"></div>`;
                        const textSpan = Math.ceil(holiday.name.length / 3);
                        if(lastDayIndex + 1 < days.length) {
                            episodeHeaderTimelineHTML += `<div class="header-holiday-text" style="grid-column: ${lastDayIndex + 2} / span ${textSpan};">${holiday.name}</div>`;
                        }
                        processedHolidays.add(holiday.name);
                    }
                }
                const month = d.getUTCMonth();
                const day = d.getUTCDate();
                if ((month === 2 && day === 31) || (month === 5 && day === 30) || (month === 8 && day === 30) || (month === 11 && day === 31)) {
                    episodeHeaderTimelineHTML += `<div class="header-quarter-marker" style="grid-column: ${i + 1};"></div>`;
                }
            });
            episodeHeaderTimelineHTML += `</div>`;

            ganttBodyHTML += `<div class="episode-header-label" data-ep-id="${epId}">
                                    <div class="episode-title-group">
                                        <div class="episode-expand-icon">+</div>
                                        <span class="episode-title-text">EP ${epId + 1}</span>
                                    </div>
                                    <div class="personnel-stack">
                                        <span class="personnel-editor">Ed: ${(ep.editors && ep.editors.length > 0) ? ep.editors.join(', ') : 'N/A'}</span>
                                        <span class="personnel-director">Dir: ${ep.director || 'N/A'}</span>
                                    </div>
                                </div>
                                ${episodeHeaderTimelineHTML}
                                <div class="episode-summary-container" id="summary-ep-${epId}">
                                    <div class="task-label">Summary</div>
                                    <div class="gantt-row" id="row-ep-${epId}-summary" style="grid-template-columns: repeat(${days.length}, var(--day-column-width));">
                                        ${days.map(d => `<div class="grid-cell ${getDayClasses(d, 'EDIT', epId, ep.editors.concat(ep.director))}" data-date-iso="${d.toISOString()}"></div>`).join('')}
                                    </div>
                                </div>
                                <div class="episode-tasks-container collapsed" id="tasks-ep-${epId}">
                                    ${rowNames.map(rowName => {
                                        const rowId = rowName.toLowerCase().replace(/\s/g, '-');
                                        return `<div class="task-label">${rowName}</div>
                                                <div class="gantt-row" id="row-ep-${epId}-${rowId}" style="grid-template-columns: repeat(${days.length}, var(--day-column-width));">
                                                    ${days.map(d => `<div class="grid-cell ${getDayClasses(d, rowName, epId, ep.editors.concat(ep.director))}" data-date-iso="${d.toISOString()}"></div>`).join('')}
                                                </div>`;
                                    }).join('')}
                                </div>`;
        });

        const timelineHeaderHTML = `<div class="gantt-header-title"></div>
            <div class="timeline-header-wrapper">
                <div class="timeline-header" style="width: calc(${days.length} * var(--day-column-width));">
                    <div class="month-headers" style="grid-template-columns: ${Object.values(monthHeaders).map(c => `calc(${c} * var(--day-column-width))`).join(' ')}">
                        ${Object.keys(monthHeaders).map(key => `<div class="month-header">${key}</div>`).join('')}
                    </div>
                    <div class="week-headers" style="grid-template-columns: ${Object.values(finalWeekHeaders).map(v => `calc(${v} * var(--day-column-width))`).join(' ')}">
                        ${Object.keys(finalWeekHeaders).map(key => `<div class="week-header">${key}</div>`).join('')}
                    </div>
                    <div class="day-headers" style="grid-template-columns: repeat(${days.length}, var(--day-column-width));">
                        ${days.map(d => `<div class="day-header ${getDayClasses(d, 'EDIT')}" data-date-iso="${toYYYYMMDD(d)}"><span class="day-name">${dayNames[d.getUTCDay()]}</span><span class="day-number">${d.getUTCDate()}</span></div>`).join('')}
                    </div>
                </div>
            </div>`;

        chart.innerHTML = timelineHeaderHTML + ganttBodyHTML;
        container.appendChild(chart);

        const diffDays = (d1, d2) => Math.floor((Date.UTC(d1.getUTCFullYear(), d1.getUTCMonth(), d1.getUTCDate()) - Date.UTC(d2.getUTCFullYear(), d2.getUTCMonth(), d2.getUTCDate())) / 86400000);

        shootingBlocks.forEach(block => {
            block.episodes.forEach(epId => {
                ['shoot', 'summary'].forEach(rowType => {
                    const row = document.getElementById(`row-ep-${epId}-${rowType}`);
                    if (row && block.startDate) {
                        const startIndex = diffDays(block.startDate, overallMinDate);
                        const durationDays = diffDays(block.endDate, block.startDate) + 1;
                        if (startIndex < 0 || startIndex >= days.length) return;

                        const bar = document.createElement('div');
                        bar.className = 'task-bar';
                        if(block.hasConflict) bar.classList.add('conflict');
                        bar.id = `block-bar-${block.blockIndex}-ep-${epId}-${rowType}`;
                        bar.textContent = rowType === 'shoot' ? `Block ${block.blockIndex + 1} Shoot` : `Block ${block.blockIndex + 1}`;
                        bar.style.left = `calc(${startIndex} * var(--day-column-width))`;
                        bar.style.width = `calc(${durationDays} * var(--day-column-width))`;
                        bar.style.backgroundColor = taskColors['SHOOT'];
                        row.appendChild(bar);
                    }
                });
            });
        });

        episodesData.forEach((ep, epId) => {
            ep.tasks.forEach((task) => {
                if (!task.isScheduled || !task.info.visible || !task.scheduledStartDate) return;
                const startIndex = diffDays(task.scheduledStartDate, overallMinDate);
                const durationDays = diffDays(task.scheduledEndDate, task.scheduledStartDate) + 1;
                if (startIndex < 0 || startIndex >= days.length) return;

                const createBar = (isSummary) => {
                    const bar = document.createElement('div');
                    bar.className = 'task-bar';
                    if (task.hasConflict) bar.classList.add('conflict');
                    bar.id = `task-bar-${task.id}${isSummary ? '-summary' : ''}`;
                    bar.textContent = task.info.name;
                    bar.style.left = `calc(${startIndex} * var(--day-column-width))`;
                    bar.style.width = `calc(${durationDays} * var(--day-column-width))`;
                    let taskColor = taskColors[task.info.name] || taskColors[task.info.department];
                    if (!taskColor && task.info.name.startsWith("Studio/Network Cut")) taskColor = taskColors["Studio/Network Cut"];
                    bar.style.backgroundColor = taskColor || '#6c757d';
                    bar.title = `${task.info.name}\nEP: ${epId + 1}\n${task.scheduledStartDate.toLocaleDateString('en-CA', {timeZone: 'UTC'})} - ${task.scheduledEndDate.toLocaleDateString('en-CA', {timeZone: 'UTC'})}`;
                    return bar;
                };

                const dept = task.info.name === 'Earliest Possible Release' ? 'DELIVERY' : task.info.department;
                const rowId = dept.toLowerCase().replace(/\s/g, '-');
                const deptRow = document.getElementById(`row-ep-${epId}-${rowId}`);

                if(deptRow) deptRow.appendChild(createBar(false));
                document.getElementById(`row-ep-${epId}-summary`).appendChild(createBar(true));
            });
        });
    }

    function getMaxStudioCuts() {
        let maxCuts = 0;
        if (!episodesData || episodesData.length === 0) return 0;
        episodesData.forEach((ep, epId) => {
            const epTasks = masterTaskList.filter(t => t.epId === epId && t.isScheduled);
            const studioCuts = epTasks.filter(t => t.info.name.startsWith("Studio/Network Cut"));
            if (studioCuts.length > maxCuts) {
                maxCuts = studioCuts.length;
            }
        });
        return maxCuts;
    }

    function getCurrentAllGridColumns() {
        const dynamicColumns = [...allGridColumns];
        const maxCuts = getMaxStudioCuts();
        const producersCutIndex = dynamicColumns.indexOf("Producer's Cut");
        for (let i = 1; i <= maxCuts; i++) {
            dynamicColumns.splice(producersCutIndex + i, 0, `S/N Cut #${i}`);
        }
        return dynamicColumns;
    }

    function renderGridView() {
        const table = document.getElementById('schedule-grid');
        table.innerHTML = '';
        if (episodesData.length === 0) return;

        if (!gridVisibleColumns) {
            gridVisibleColumns = getCurrentAllGridColumns();
        }

        const formatDate = (date) => date ? new Date(date).toLocaleDateString('en-US', { year: '2-digit', month: '2-digit', day: '2-digit', timeZone: 'UTC' }) : 'N/A';
        const maxStudioCuts = getMaxStudioCuts();

        const gridData = episodesData.map((ep, epId) => {
            const epTasks = masterTaskList.filter(t => t.epId === epId && t.isScheduled);

            const findDate = (name) => {
                const task = epTasks.find(t => t.info.name.startsWith(name));
                return task ? task.scheduledEndDate : null;
            };

            const findDates = (name) => {
                return epTasks
                    .filter(t => t.info.name.startsWith(name))
                    .sort((a, b) => a.scheduledStartDate - b.scheduledStartDate)
                    .map(t => t.scheduledEndDate);
            };

            const studioCuts = findDates("Studio/Network Cut");
            const shootingBlocks = getShootingBlocks();
            const blockInfo = shootingBlocks.find(b => b.episodes.includes(epId));

            return {
                ep: epId + 1,
                director: ep.director || 'N/A',
                editor: (ep.editors && ep.editors.length > 0) ? ep.editors.join(', ') : 'N/A',
                block: blockInfo ? `Block ${blockInfo.blockIndex + 1}` : 'N/A',
                shootDates: blockInfo ? `${formatDate(blockInfo.startDate)} - ${formatDate(blockInfo.endDate)}` : 'N/A',
                editorsCut: formatDate(findDate("Editor's Cut")),
                directorsCut: formatDate(findDate("Director's Cut v2")),
                producersCut: formatDate(findDate("Producer's Cut")),
                studioCuts: studioCuts.map(formatDate),
                lock: formatDate(findDate("Picture Lock")),
                color: formatDate(findDate("Final Color Grade")),
                finalMix: formatDate(findDate("Final Mix")),
                qcDelivery: formatDate(findDate("Deliver to QC")),
                finalDelivery: formatDate(findDate("Final Delivery")),
                earliestRelease: formatDate(findDate("Earliest Possible Release"))
            };
        });

        ['block', 'director', 'shootDates'].forEach(key => {
            for (let i = 0; i < gridData.length; i++) {
                if (i > 0 && gridData[i][key] === gridData[i - 1][key]) {
                    gridData[i][`${key}Rowspan`] = 0;
                } else {
                    let count = 1;
                    for (let j = i + 1; j < gridData.length; j++) {
                        if (gridData[j][key] === gridData[i][key]) count++;
                        else break;
                    }
                    gridData[i][`${key}Rowspan`] = count;
                }
            }
        });

        const currentAllCols = getCurrentAllGridColumns();
        const displayedHeaders = currentAllCols.filter(col => gridVisibleColumns.includes(col));
        if (!displayedHeaders.includes('EP')) {
            displayedHeaders.unshift('EP');
        }

        const totalCols = displayedHeaders.length;
        const createdBy = document.getElementById('created-by').value;
        const showName = document.getElementById('show-name').value;
        const version = document.getElementById('schedule-version').value;
        const creationDate = getFormattedTimestamp();
        const totalShootDays = document.getElementById('total-shoot-days-display').textContent;
        const shootingBlocks = getShootingBlocks();
        const shootPeriodStart = shootingBlocks.length > 0 ? formatDate(shootingBlocks[0].startDate) : 'N/A';
        const shootPeriodEnd = shootingBlocks.length > 0 ? formatDate(shootingBlocks[shootingBlocks.length - 1].endDate) : 'N/A';

        let topHeaderHTML = `
        <thead>
            <tr>
                <th colspan="${totalCols}" style="text-align:left; padding:10px;">
                    <div id="grid-info-header">
                        <div><b>Show Name:</b> ${showName}</div>
                        <div><b>Version:</b> ${version}</div>
                        <div><b>Created By:</b> ${createdBy}</div>
                        <div><b>Shoot Period:</b> ${shootPeriodStart} - ${shootPeriodEnd}</div>
                        <div><b>Total Shoot Days:</b> ${totalShootDays}</div>
                        <div><b>Generated:</b> ${creationDate}</div>
                    </div>
                </th>
            </tr>
            <tr>${displayedHeaders.map(h => `<th>${h}</th>`).join('')}</tr>
        </thead>`;

        let bodyHTML = '<tbody>';
        gridData.forEach(row => {
            bodyHTML += '<tr>';
            if (gridVisibleColumns.includes('Block') && row.blockRowspan > 0) bodyHTML += `<td rowspan="${row.blockRowspan}">${row.block}</td>`;
            bodyHTML += `<td>${row.ep}</td>`;
            if (gridVisibleColumns.includes('Director') && row.directorRowspan > 0) bodyHTML += `<td rowspan="${row.directorRowspan}">${row.director}</td>`;
            if (gridVisibleColumns.includes('Editor')) bodyHTML += `<td>${row.editor}</td>`;
            if (gridVisibleColumns.includes('Shoot Dates') && row.shootDatesRowspan > 0) bodyHTML += `<td rowspan="${row.shootDatesRowspan}">${row.shootDates}</td>`;
            if (gridVisibleColumns.includes("Editor's Cut")) bodyHTML += `<td>${row.editorsCut}</td>`;
            if (gridVisibleColumns.includes("Director's Cut")) bodyHTML += `<td>${row.directorsCut}</td>`;
            if (gridVisibleColumns.includes("Producer's Cut")) bodyHTML += `<td>${row.producersCut}</td>`;

            for (let i = 0; i < maxStudioCuts; i++) {
                if (gridVisibleColumns.includes(`S/N Cut #${i + 1}`)) {
                    bodyHTML += `<td>${row.studioCuts[i] || ''}</td>`;
                }
            }

            if (gridVisibleColumns.includes('Lock')) bodyHTML += `<td>${row.lock}</td>`;
            if (gridVisibleColumns.includes('Color')) bodyHTML += `<td>${row.color}</td>`;
            if (gridVisibleColumns.includes('Final Mix')) bodyHTML += `<td>${row.finalMix}</td>`;
            if (gridVisibleColumns.includes('QC Delivery')) bodyHTML += `<td>${row.qcDelivery}</td>`;
            if (gridVisibleColumns.includes('Final Delivery')) bodyHTML += `<td>${row.finalDelivery}</td>`;
            if (gridVisibleColumns.includes('Earliest Release')) bodyHTML += `<td>${row.earliestRelease}</td>`;
            bodyHTML += '</tr>';
        });
        bodyHTML += '</tbody>';

        table.innerHTML = topHeaderHTML + bodyHTML;
    }

    function renderWaterfallChart() {
        checkForConflicts();
        const container = document.getElementById('waterfall-container');
        container.innerHTML = '';
        if (masterTaskList.length === 0 || !overallMinDate || !overallMaxDate || isNaN(overallMinDate.getTime()) || isNaN(overallMaxDate.getTime())) return;

        const diffDays = (d1, d2) => Math.floor((Date.UTC(d1.getUTCFullYear(), d1.getUTCMonth(), d1.getUTCDate()) - Date.UTC(d2.getUTCFullYear(), d2.getUTCMonth(), d2.getUTCDate())) / 86400000);
        const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

        const days = [];
        let currentDate = new Date(Date.UTC(overallMinDate.getUTCFullYear(), overallMinDate.getUTCMonth(), overallMinDate.getUTCDate()));
        const lastDate = new Date(Date.UTC(overallMaxDate.getUTCFullYear(), overallMaxDate.getUTCMonth(), overallMaxDate.getUTCDate()));
        while (currentDate <= lastDate) {
            days.push(new Date(currentDate));
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }

        const chart = document.createElement('div');
        chart.className = 'waterfall-chart';
        const departments = ['Summary', 'Shoot', 'EDIT', 'MUSIC', 'VFX', 'PICTURE', 'SOUND', 'DELIVERY'];

        let headerHTML = `<div class="waterfall-header">
                                    <div class="waterfall-date-col waterfall-week-col">Wk#</div>
                                    <div class="waterfall-date-col waterfall-day-of-week-col">Day</div>
                                    <div class="waterfall-date-col waterfall-day-col">Date</div>`;
        episodesData.forEach((ep, epId) => {
            headerHTML += `<div class="waterfall-ep-header-group" id="waterfall-header-ep-${epId}" style="width: var(--waterfall-ep-col-width)">
                                <div class="waterfall-ep-header" data-ep-id="${epId}">
                                    <div class="episode-title-group">
                                         <div class="episode-expand-icon">+</div>
                                        <span>EP ${epId + 1}</span>
                                    </div>
                                    <div class="personnel-stack">
                                        <span class="personnel-director">Dir: ${ep.director || 'N/A'}</span>
                                        <span class="personnel-editor">Ed: ${(ep.editors && ep.editors.length > 0) ? ep.editors.join(', ') : 'N/A'}</span>
                                    </div>
                                </div>
                                <div class="waterfall-dept-header">
                                    ${departments.map(d => `<div class="waterfall-dept-col" data-dept="${d.toLowerCase()}" style="width: ${d === 'Summary' ? 'var(--waterfall-ep-col-width)' : 'var(--waterfall-dept-col-width)'}; ${d !== 'Summary' ? 'display:none;' : ''}">${d}</div>`).join('')}
                                </div>
                            </div>`;
        });
        headerHTML += '</div>';

        let bodyHTML = '<div class="waterfall-body">';
        let weekNum = 1;
        const startOfPhotography = new Date(document.getElementById('start-of-photography').value + 'T12:00:00Z');

        let weekColHTML = `<div class="waterfall-date-col waterfall-week-col">${days.map(d => {
            let weekLabel = '&nbsp;';
            if (d.getUTCDay() === 1 && d >= startOfPhotography) {
                weekLabel = `W${weekNum++}`;
            }
            return `<div class="waterfall-date-label">${weekLabel}</div>`;
        }).join('')}</div>`;

        let dayOfWeekColHTML = `<div class="waterfall-date-col waterfall-day-of-week-col">${days.map(d => `<div class="waterfall-date-label">${dayNames[d.getUTCDay()]}</div>`).join('')}</div>`;

        let dateColHTML = `<div class="waterfall-date-col waterfall-day-col">${days.map((d, i) => {
            const isQuarterEnd = (d.getUTCMonth() === 2 && d.getUTCDate() === 31) || (d.getUTCMonth() === 5 && d.getUTCDate() === 30) || (d.getUTCMonth() === 8 && d.getUTCDate() === 30) || (d.getUTCMonth() === 11 && d.getUTCDate() === 31);
            return `<div class="waterfall-date-label ${isQuarterEnd ? 'quarter-end' : ''}" data-row-index="${i}">${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</div>`
        }).join('')}</div>`;

        let epColsHTML = '<div class="waterfall-timeline" style="display: flex;">';
        episodesData.forEach((ep, epId) => {
            epColsHTML += `<div class="waterfall-ep-column" id="waterfall-ep-col-${epId}" style="width: var(--waterfall-ep-col-width); display:flex;">`;

            departments.forEach(dept => {
                epColsHTML += `<div class="waterfall-dept-column" data-dept="${dept.toLowerCase()}" style="width: ${dept === 'Summary' ? 'var(--waterfall-ep-col-width)' : 'var(--waterfall-dept-col-width)'}; ${dept === 'Summary' ? '' : 'display:none;'}">`;

                days.forEach((d, i) => {
                    let dayClasses = 'waterfall-day-row';
                    const holidayCheckDept = (dept === 'Summary' || dept === 'Shoot') ? 'EDIT' : dept;
                    const holiday = getHolidayForDate(d, holidayCheckDept);
                    let isHiatus = false;
                    for (const hiatus of hiatuses) {
                        const start = new Date(hiatus.start + 'T12:00:00Z');
                        const end = new Date(hiatus.end + 'T12:00:00Z');
                        if (d >= start && d <= end) {
                            isHiatus = true;
                            break;
                        }
                    }

                    if (isHiatus || holiday) {
                        dayClasses += ' hiatus-day';
                    } else if (!isBusinessDay(d, holidayCheckDept, epId, ep.editors.concat(ep.director))) {
                        dayClasses += ' non-work-day';
                    }

                    epColsHTML += `<div class="${dayClasses}" data-row-index="${i}" data-date-iso="${d.toISOString()}">
                                                ${holiday ? `<span class="holiday-name">${holiday.name}</span>` : ''}
                                            </div>`;
                });

                let tasksForDept = [];
                if (dept === 'Summary') {
                    tasksForDept = masterTaskList.filter(t => t.epId === epId && t.isScheduled && t.info.visible);
                    const shootBlocks = getShootingBlocks().filter(b => b.episodes.includes(epId)).map(block => ({
                        id: `block-${block.blockIndex}-ep${epId}`,
                        info: { name: `Block ${block.blockIndex + 1} Shoot`, department: 'SHOOT' },
                        scheduledStartDate: block.startDate,
                        scheduledEndDate: block.endDate,
                        hasConflict: block.hasConflict,
                    }));
                    tasksForDept.push(...shootBlocks);
                } else if(dept === 'Shoot') {
                    tasksForDept = getShootingBlocks().filter(b => b.episodes.includes(epId)).map(block => ({
                        id: `block-${block.blockIndex}-ep${epId}`,
                        info: { name: `Block ${block.blockIndex + 1} Shoot`, department: 'SHOOT' },
                        scheduledStartDate: block.startDate,
                        scheduledEndDate: block.endDate,
                        hasConflict: block.hasConflict,
                    }));
                } else {
                    tasksForDept = masterTaskList.filter(t => t.epId === epId && t.info.department === dept && t.isScheduled && t.info.visible);
                }

                tasksForDept.forEach(task => {
                    if (!task.scheduledStartDate || !task.scheduledEndDate) return;
                    const top = diffDays(task.scheduledStartDate, overallMinDate) * 30;
                    const height = (diffDays(task.scheduledEndDate, task.scheduledStartDate) + 1) * 30;
                    const taskColor = taskColors[task.info.name] || taskColors[task.info.department] ||'#6c757d';
                    let classList = 'waterfall-task-bar';
                    if(task.hasConflict) classList += ' conflict';

                    epColsHTML += `<div
                                            class="${classList}"
                                            id="w-task-bar__${task.id}__${dept.toLowerCase()}"
                                            style="top: ${top}px; height: ${height-2}px; background-color: ${taskColor}"
                                            title="${task.info.name}">
                                            ${task.info.name}
                                        </div>`;
                });

                epColsHTML += `</div>`;
            });
            epColsHTML += `</div>`;
        });
        epColsHTML += '</div>';

        bodyHTML += weekColHTML + dayOfWeekColHTML + dateColHTML + epColsHTML + '</div>';
        chart.innerHTML = headerHTML + bodyHTML;
        container.appendChild(chart);
    }

    function getShootDayOverrides() {
        const overrides = {};
        const overrideString = document.getElementById('shoot-day-overrides').value.trim();
        if (overrideString) {
            const pairs = overrideString.split(',');
            pairs.forEach(pair => {
                const parts = pair.split(':');
                if (parts.length === 2) {
                    const epNumber = parseInt(parts[0].trim(), 10);
                    const days = parseInt(parts[1].trim(), 10);
                    if (!isNaN(epNumber) && !isNaN(days) && epNumber > 0) {
                        overrides[epNumber - 1] = days;
                    }
                }
            });
        }
        return overrides;
    }

    function getShootingBlocks() {
        const numBlocks = parseInt(document.getElementById('num-shoot-blocks').value);
        const numEpisodes = parseInt(document.getElementById('num-episodes').value);
        const defaultShootDaysPerEp = parseInt(document.getElementById('shoot-days-per-ep').value);
        const shootDayOverrides = getShootDayOverrides();
        const startOfPhotographyValue = document.getElementById('start-of-photography').value;
        if (!startOfPhotographyValue) return [];

        const startOfPhotography = new Date(startOfPhotographyValue + 'T12:00:00Z');

        const shootingBlocks = [];
        let currentStartDate = new Date(startOfPhotography.getTime());
        let episodeCounter = 0;

        const getShootDaysForEp = (epId) => shootDayOverrides[epId] !== undefined ? shootDayOverrides[epId] : defaultShootDaysPerEp;

        if (numBlocks === 1) {
            let totalShootDays = 0;
            const blockEpisodes = [];
            for (let i = 0; i < numEpisodes; i++) {
                totalShootDays += getShootDaysForEp(i);
                blockEpisodes.push(i);
            }
            const blockEndDate = addBusinessDays(currentStartDate, totalShootDays, 'SHOOT');
            shootingBlocks.push({ blockIndex: 0, episodes: blockEpisodes, startDate: currentStartDate, endDate: blockEndDate });
            return shootingBlocks;
        }

        for (let i = 0; i < numBlocks; i++) {
            const blockEpsInput = document.getElementById(`block-eps-${i}`);
            if (!blockEpsInput) continue;
            const epsInBlock = parseInt(blockEpsInput.value);

            let blockShootDays = 0;
            const blockEpisodes = [];
            for(let j=0; j < epsInBlock && episodeCounter < numEpisodes; j++) {
                blockShootDays += getShootDaysForEp(episodeCounter);
                blockEpisodes.push(episodeCounter++);
            }

            const blockEndDate = addBusinessDays(currentStartDate, blockShootDays, 'SHOOT');
            shootingBlocks.push({ blockIndex: i, episodes: blockEpisodes, startDate: currentStartDate, endDate: blockEndDate });
            currentStartDate = findNextBusinessDay(blockEndDate, 'SHOOT');
        }
        return shootingBlocks;
    }

    function releaseAnchors(task) {
        if (!task || !task.isManuallySet) return;

        unanchorTaskAndSuccessors(task);
        calculateAndRender();
    }

    function unanchorTaskAndSuccessors(task) {
        if (!task || !task.isManuallySet) return;
        task.isManuallySet = false;

        const successors = masterTaskList.filter(t => (t.originalPredecessors || []).some(p => p.task.id === task.id));
        successors.forEach(s => unanchorTaskAndSuccessors(s));
    }
    
    function applyOffsetToSuccessors(task, offset) {
        if (!task || offset === 0) return;
    
        // Move the current task
        task.scheduledStartDate = addBusinessDaysWithOffset(task.scheduledStartDate, offset, task.info.department, task.epId, task.resources);
        task.scheduledEndDate = addBusinessDays(task.scheduledStartDate, task.info.duration, task.info.department, task.epId, task.resources);
        task.isManuallySet = true;
    
        // Find all tasks that have this task as a direct predecessor
        const successors = masterTaskList.filter(t => t.predecessors.some(p => p.task.id === task.id));
    
        // Recursively call this function for each successor
        successors.forEach(s => applyOffsetToSuccessors(s, offset));
    }


    function setupAllEventListeners() {
        const ganttContainer = document.getElementById('gantt-container');
        const waterfallContainer = document.getElementById('waterfall-container');

        ganttContainer.addEventListener('click', (e) => {
            const bar = e.target.closest('.task-bar');
            if (bar && !e.target.closest('.personnel-stack')) {
                let taskId = bar.id.replace('task-bar-', '').replace('-summary', '');
                const task = masterTaskList.find(t => t.id === taskId);

                if (task && task.isManuallySet) {
                    if (confirm('This task was moved manually. Do you want to release it and have it reschedule automatically?')) {
                        releaseAnchors(task);
                    }
                    return;
                }
            }

            const header = e.target.closest('.episode-header-label');
            if (header && !e.target.closest('.personnel-stack')) {
                const epId = header.dataset.epId;
                const tasksContainer = document.getElementById(`tasks-ep-${epId}`);
                const summaryContainer = document.getElementById(`summary-ep-${epId}`);

                const isExpanded = header.classList.toggle('expanded');

                if (tasksContainer && summaryContainer) {
                    tasksContainer.classList.toggle('collapsed');
                    summaryContainer.classList.toggle('collapsed');
                    header.querySelector('.episode-expand-icon').textContent = isExpanded ? '−' : '+';
                }
            }
        });

        waterfallContainer.addEventListener('click', (e) => {
            const header = e.target.closest('.waterfall-ep-header');
            if (header) {
                const isExpanded = header.classList.toggle('expanded');
                header.querySelector('.episode-expand-icon').textContent = isExpanded ? '−' : '+';

                const epId = header.dataset.epId;
                const headerGroup = document.getElementById(`waterfall-header-ep-${epId}`);
                const epCol = document.getElementById(`waterfall-ep-col-${epId}`);

                const deptHeaders = headerGroup.querySelectorAll('.waterfall-dept-col');
                const deptCols = epCol.querySelectorAll('.waterfall-dept-column');
                const departments = ['Summary', 'Shoot', 'EDIT', 'MUSIC', 'VFX', 'PICTURE', 'SOUND', 'DELIVERY'];

                if (isExpanded) {
                    const expandedWidth = `calc(var(--waterfall-dept-col-width) * ${departments.length - 1})`;
                    headerGroup.style.width = expandedWidth;
                    epCol.style.width = expandedWidth;

                    deptHeaders.forEach(dh => {
                        dh.style.display = dh.dataset.dept === 'summary' ? 'none' : 'flex';
                    });
                    deptCols.forEach(dc => {
                        dc.style.display = dc.dataset.dept === 'summary' ? 'none' : 'block';
                    });
                } else {
                    headerGroup.style.width = `var(--waterfall-ep-col-width)`;
                    epCol.style.width = `var(--waterfall-ep-col-width)`;
                    deptHeaders.forEach(dh => {
                        dh.style.display = dh.dataset.dept === 'summary' ? 'flex' : 'none';
                    });
                    deptCols.forEach(dc => {
                        dc.style.display = dc.dataset.dept === 'summary' ? 'block' : 'none';
                    });
                }
            }
        });

        addManualDragListeners();
        addWaterfallDragListeners();
    }

    function anchorTaskAndPredecessors(task) {
        if (!task || task.isManuallySet) return;

        task.isManuallySet = true;
        if (task.predecessors) {
            task.predecessors.forEach(p => {
                if (p && p.task) {
                    anchorTaskAndPredecessors(p.task);
                }
            });
        }
    }

    // Enhanced drag listener functions that better handle the different modes
function addManualDragListeners() {
    let draggedState = null;
    let ghostElement = null;
    let currentDropTarget = null;
    
    const onMouseDown = (e) => {
        if (e.button !== 0) return;
        const bar = e.target.closest('.task-bar');
        if (!bar || bar.textContent.toLowerCase().includes('shoot')) return;
        
        let taskId = bar.id.replace('task-bar-', '').replace('-summary', '');
        const task = taskId ? masterTaskList.find(t => t.id === taskId) : null;
        if (!task) return;
        
        // Enhanced ghost element creation
        ghostElement = bar.cloneNode(true);
        ghostElement.classList.add('ghost');
        ghostElement.style.cssText = `
            position: fixed; pointer-events: none; z-index: 10000;
            opacity: 0.8; background-color: #3b82f6; color: white;
            border: 2px solid #1d4ed8; border-radius: 4px;
        `;
        document.body.appendChild(ghostElement);
        ghostElement.style.width = `${bar.offsetWidth}px`;
        ghostElement.style.left = `${e.clientX - (bar.offsetWidth / 2)}px`;
        ghostElement.style.top = `${e.clientY - (bar.offsetHeight / 2)}px`;
        
        draggedState = { taskObject: task, element: bar };
        bar.classList.add('dragging');
        
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp, { once: true });
    };
    
    const onMouseMove = (e) => {
        if (!draggedState) return;
        
        ghostElement.style.left = `${e.clientX - (ghostElement.offsetWidth / 2)}px`;
        ghostElement.style.top = `${e.clientY - (ghostElement.offsetHeight / 2)}px`;
        
        ghostElement.style.display = 'none';
        const newDropTarget = document.elementFromPoint(e.clientX, e.clientY)?.closest('.grid-cell');
        ghostElement.style.display = '';
        
        if (currentDropTarget && currentDropTarget !== newDropTarget) {
            currentDropTarget.classList.remove('drop-target');
        }
        if (newDropTarget && newDropTarget.dataset.dateIso) {
            newDropTarget.classList.add('drop-target');
            currentDropTarget = newDropTarget;
        } else {
            currentDropTarget = null;
        }
    };
    
    const onMouseUp = (e) => {
        if (ghostElement) ghostElement.remove();
        if (currentDropTarget) currentDropTarget.classList.remove('drop-target');
        if (!draggedState) {
            document.removeEventListener('mousemove', onMouseMove);
            return;
        }
        draggedState.element.classList.remove('dragging');
        document.removeEventListener('mousemove', onMouseMove);
        
        if (currentDropTarget && currentDropTarget.dataset.dateIso) {
            const newStartDate = new Date(currentDropTarget.dataset.dateIso);
            const task = draggedState.taskObject;
            const isLinkedMode = !unlinkToggle.checked;
            
            // Store original state for potential reversion
            const originalState = {
                isManuallySet: task.isManuallySet,
                scheduledStartDate: task.scheduledStartDate ? new Date(task.scheduledStartDate) : null,
                scheduledEndDate: task.scheduledEndDate ? new Date(task.scheduledEndDate) : null,
                predecessors: task.predecessors ? [...task.predecessors] : [],
                manualStartDate: task.manualStartDate ? new Date(task.manualStartDate) : null
            };
            
            if (isLinkedMode) {
                // IMPROVED LINKED mode - smarter task linking with cascade prevention
                const timeShift = newStartDate.getTime() - task.scheduledStartDate.getTime();
                
                // Update the dragged task
                task.isManuallySet = true;
                task.isScheduled = true;
                task.scheduledStartDate = newStartDate;
                task.scheduledEndDate = addBusinessDays(newStartDate, task.info.duration, task.info.department, task.epId, task.resources);
                task.originalPredecessors = task.originalPredecessors || [...task.predecessors];
                task.predecessors = [];
                
                // Clean up any existing manual start date
                if (task.manualStartDate) {
                    delete task.manualStartDate;
                }
                
                // Smart linking logic - only affect related tasks in same or later episodes
                const linkedTasks = [];
                
                if (task.info.name === "Producer Notes") {
                    const dcv2 = masterTaskList.find(t => 
                        t.epId === task.epId && 
                        t.info.name === "Director's Cut v2" &&
                        !t.isManuallySet &&
                        t.isScheduled
                    );
                    if (dcv2) linkedTasks.push(dcv2);
                }
                
                if (task.info.name === "Director's Cut v2") {
                    // Only link subsequent tasks in SAME episode to prevent cascade
                    const sameEpisodeTasks = masterTaskList.filter(t => 
                        t.epId === task.epId &&
                        t.isScheduled &&
                        !t.isManuallySet &&
                        t.scheduledStartDate >= task.scheduledStartDate &&
                        (t.info.name === "Producer's Cut" || t.info.name.includes("Cut") || t.info.name === "Notes")
                    );
                    linkedTasks.push(...sameEpisodeTasks);
                }
                
                // Apply time shifts to linked tasks with boundary protection
                linkedTasks.forEach(linkedTask => {
                    const newStart = new Date(linkedTask.scheduledStartDate.getTime() + timeShift);
                    const newEnd = addBusinessDays(newStart, linkedTask.info.duration, linkedTask.info.department, linkedTask.epId, linkedTask.resources);
                    
                    linkedTask.scheduledStartDate = newStart;
                    linkedTask.scheduledEndDate = newEnd;
                    linkedTask.isManuallySet = true;
                    linkedTask.originalPredecessors = linkedTask.originalPredecessors || [...linkedTask.predecessors];
                    linkedTask.predecessors = [];
                });
                
                renderAllViews();
            
            } else {
            // UNLINKED mode - set manual start date but keep in scheduling system
            task.manualStartDate = newStartDate;
            task.isManuallySet = false;
            
            // Clean up any previous manual positioning
            if (originalState.isManuallySet) {
                task.isScheduled = false;
                // Restore original predecessors if it was previously manually set
                if (task.originalPredecessors) {
                    task.predecessors = task.originalPredecessors.map(p => ({ ...p }));
                    delete task.originalPredecessors; // Clean up after restoration
                }
            }
            
            calculateAndRender();
             }
        }
        draggedState = null;
        ghostElement = null;
    };
    
    document.getElementById('gantt-container').addEventListener('mousedown', onMouseDown);
}

// Enhanced waterfall drag listeners with the same logic
function addWaterfallDragListeners() {
    let draggedState = null;
    let ghostElement = null;
    let currentDropTarget = null;
    
    const onMouseDown = (e) => {
        if (e.button !== 0) return;
        const bar = e.target.closest('.waterfall-task-bar');
        if (!bar || bar.id.includes('block')) return;
        
        const parts = bar.id.split('__');
        const taskId = parts[1];
        const task = taskId ? masterTaskList.find(t => t.id === taskId) : null;
        if (!task) return;
        
        // Enhanced ghost element creation
        ghostElement = bar.cloneNode(true);
        ghostElement.classList.add('ghost');
        ghostElement.style.cssText = `
            position: fixed; pointer-events: none; z-index: 10000;
            opacity: 0.8; background-color: #3b82f6; color: white;
            border: 2px solid #1d4ed8; border-radius: 4px;
        `;
        document.body.appendChild(ghostElement);
        ghostElement.style.width = `${bar.offsetWidth}px`;
        ghostElement.style.height = `${bar.offsetHeight}px`;
        ghostElement.style.left = `${e.clientX - (bar.offsetWidth / 2)}px`;
        ghostElement.style.top = `${e.clientY - 15}px`;
        
        draggedState = { taskObject: task, element: bar };
        bar.classList.add('dragging');
        
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp, { once: true });
    };
    
    const onMouseMove = (e) => {
        if (!draggedState) return;
        
        ghostElement.style.left = `${e.clientX - (ghostElement.offsetWidth / 2)}px`;
        ghostElement.style.top = `${e.clientY - 15}px`;
        
        ghostElement.style.display = 'none';
        const newDropTarget = document.elementFromPoint(e.clientX, e.clientY)?.closest('.waterfall-day-row');
        ghostElement.style.display = '';
        
        if (currentDropTarget && currentDropTarget !== newDropTarget) {
            currentDropTarget.classList.remove('drop-target');
        }
        if (newDropTarget && newDropTarget.dataset.dateIso) {
            newDropTarget.classList.add('drop-target');
            currentDropTarget = newDropTarget;
        } else {
            currentDropTarget = null;
        }
    };
    
    const onMouseUp = (e) => {
        if (ghostElement) ghostElement.remove();
        if (currentDropTarget) currentDropTarget.classList.remove('drop-target');
        if (!draggedState) {
            document.removeEventListener('mousemove', onMouseMove);
            return;
        }
        draggedState.element.classList.remove('dragging');
        document.removeEventListener('mousemove', onMouseMove);
        
        if (currentDropTarget && currentDropTarget.dataset.dateIso) {
            const newStartDate = new Date(currentDropTarget.dataset.dateIso);
            const task = draggedState.taskObject;
            const isLinkedMode = !unlinkToggle.checked;
            
            // Store original state for potential reversion
            const originalState = {
                isManuallySet: task.isManuallySet,
                scheduledStartDate: task.scheduledStartDate ? new Date(task.scheduledStartDate) : null,
                scheduledEndDate: task.scheduledEndDate ? new Date(task.scheduledEndDate) : null,
                predecessors: task.predecessors ? [...task.predecessors] : [],
                manualStartDate: task.manualStartDate ? new Date(task.manualStartDate) : null
            };
            
            if (isLinkedMode) {
                // IMPROVED LINKED mode - smarter task linking with cascade prevention
                const timeShift = newStartDate.getTime() - task.scheduledStartDate.getTime();
                
                // Update the dragged task
                task.isManuallySet = true;
                task.isScheduled = true;
                task.scheduledStartDate = newStartDate;
                task.scheduledEndDate = addBusinessDays(newStartDate, task.info.duration, task.info.department, task.epId, task.resources);
                task.originalPredecessors = task.originalPredecessors || [...task.predecessors];
                task.predecessors = [];
                
                // Clean up any existing manual start date
                if (task.manualStartDate) {
                    delete task.manualStartDate;
                }
                
                // Smart linking logic - only affect related tasks in same or later episodes
                const linkedTasks = [];
                
                if (task.info.name === "Producer Notes") {
                    const dcv2 = masterTaskList.find(t => 
                        t.epId === task.epId && 
                        t.info.name === "Director's Cut v2" &&
                        !t.isManuallySet &&
                        t.isScheduled
                    );
                    if (dcv2) linkedTasks.push(dcv2);
                }
                
                if (task.info.name === "Director's Cut v2") {
                    // Only link subsequent tasks in SAME episode to prevent cascade
                    const sameEpisodeTasks = masterTaskList.filter(t => 
                        t.epId === task.epId &&
                        t.isScheduled &&
                        !t.isManuallySet &&
                        t.scheduledStartDate >= task.scheduledStartDate &&
                        (t.info.name === "Producer's Cut" || t.info.name.includes("Cut") || t.info.name === "Notes")
                    );
                    linkedTasks.push(...sameEpisodeTasks);
                }
                
                // Apply time shifts to linked tasks with boundary protection
                linkedTasks.forEach(linkedTask => {
                    const newStart = new Date(linkedTask.scheduledStartDate.getTime() + timeShift);
                    const newEnd = addBusinessDays(newStart, linkedTask.info.duration, linkedTask.info.department, linkedTask.epId, linkedTask.resources);
                    
                    linkedTask.scheduledStartDate = newStart;
                    linkedTask.scheduledEndDate = newEnd;
                    linkedTask.isManuallySet = true;
                    linkedTask.originalPredecessors = linkedTask.originalPredecessors || [...linkedTask.predecessors];
                    linkedTask.predecessors = [];
                });
                
                renderAllViews();

            } else {
            // UNLINKED mode - set manual start date but keep in scheduling system
            task.manualStartDate = newStartDate;
            task.isManuallySet = false;
            
            // Clean up any previous manual positioning
            if (originalState.isManuallySet) {
                task.isScheduled = false;
                // Restore original predecessors if it was previously manually set
                if (task.originalPredecessors) {
                    task.predecessors = task.originalPredecessors.map(p => ({ ...p }));
                    delete task.originalPredecessors; // Clean up after restoration
                }
            }
            
            calculateAndRender();
        }
    }  // This closes the if (currentDropTarget && currentDropTarget.dataset.dateIso)
    
    draggedState = null;
    ghostElement = null;
};  // This closes the onMouseUp function

document.getElementById('waterfall-container').addEventListener('mousedown', onMouseDown);
}  // This closes addWaterfallDragListeners

    function setupTabControls() {
        const tabButtons = document.querySelectorAll('.tab-button');
        const viewContainers = document.querySelectorAll('.view-container');
        const exportButton = document.getElementById('export-smart');

        tabButtons.forEach(button => {
            button.addEventListener('click', () => {
                tabButtons.forEach(btn => btn.classList.remove('active'));
                button.classList.add('active');

                currentView = button.id.replace('tab-', '');
                const viewId = `${currentView}-view`;

                viewContainers.forEach(container => {
                    container.classList.toggle('hidden', container.id !== viewId);
                });

                if (currentView === 'grid') {
                    renderGridView();
                    viewState.grid = 'fresh';
                } else if (currentView === 'budget') {
                    renderBudgetView();
                    viewState.budget = 'fresh';
                } else {
                    if (currentView === 'timeline' && viewState.timeline === 'stale'){
                        renderGanttChart();
                        viewState.timeline = 'fresh';
                    }
                    else if (currentView === 'waterfall' && viewState.waterfall === 'stale') {
                        renderWaterfallChart();
                        viewState.waterfall = 'fresh';
                    }
                }

                if (currentView === 'timeline') {
                    exportButton.textContent = 'Timeline (XLSX)';
                    exportButton.onclick = exportTimelineToExcel;
                } else if (currentView === 'waterfall') {
                    exportButton.textContent = 'Waterfall (XLSX)';
                    exportButton.onclick = exportWaterfallToExcel;
                } else if (currentView === 'grid') {
                    exportButton.textContent = 'Grid (PDF)';
                    exportButton.onclick = exportGridToPDF;
                } else if (currentView === 'budget') {
                    exportButton.textContent = 'Export Budget (XLSX)';
                    exportButton.onclick = exportBudgetToExcel;
                }
            });
        });
        document.getElementById('export-smart').onclick = exportTimelineToExcel;
        document.getElementById('export-calendar').addEventListener('click', exportToICS);
    }

    function getFormattedTimestamp() {
        const now = new Date();
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const day = now.getDate().toString().padStart(2, '0');
        const year = now.getFullYear().toString().slice(-2);
        let hours = now.getHours();
        const minutes = now.getMinutes().toString().padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12;
        hours = hours ? hours : 12;
        const strTime = hours.toString().padStart(2, '0') + ':' + minutes + ' ' + ampm;
        return `${month}/${day}/${year}, ${strTime}`;
    }


    function generateExportFilename() {
        const showCode = document.getElementById('show-code').value.replace(/[^a-z0-9]/gi, '_').toUpperCase() || 'SHOW';
        const version = "v" + document.getElementById('schedule-version').value || "1";

        const startDateValue = document.getElementById('start-of-photography').value;
        let startDateStr = 'NoDate';
        if (startDateValue) {
            const startDate = new Date(startDateValue + 'T12:00:00Z');
            const month = startDate.toLocaleString('default', { month: 'short', timeZone: 'UTC' });
            const day = startDate.getUTCDate();
            startDateStr = `${month}${day}`;
        }

        const shootDays = document.getElementById('total-shoot-days-display').textContent + "Days";

        const numBlocks = parseInt(document.getElementById('num-shoot-blocks').value);
        let epsPerBlockStr = '';
        if (numBlocks === 1) {
            epsPerBlockStr = 'Crossboarded';
        } else {
            const epsPerBlock = [];
            for (let i = 0; i < numBlocks; i++) {
                const input = document.getElementById(`block-eps-${i}`);
                if(input) epsPerBlock.push(input.value);
            }
            epsPerBlockStr = epsPerBlock.join('');
        }

        const numDirectors = document.getElementById('num-directors').value + "Dir";
        const numEditors = document.getElementById('num-editors').value + "Eds";

        return `${showCode}_${version}_${startDateStr}_${shootDays}_${epsPerBlockStr}_${numDirectors}_${numEditors}`;
    }

    function exportToICS() {
        const shootingBlocks = getShootingBlocks();
        const departments = ['Shoot', 'EDIT', 'MUSIC', 'VFX', 'PICTURE', 'SOUND', 'DELIVERY'];

        const formatICSDate = (date, isEndDate = false) => {
            const d = new Date(date);
            if (isEndDate) {
                d.setUTCDate(d.getUTCDate() + 1);
            }
            return d.toISOString().replace(/-/g, '').replace(/:/g, '').replace(/\.\d{3}/, '');
        }

        departments.forEach(dept => {
            let icsString = [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'PRODID:-//GeminiScheduler//Beta v3.1//EN',
                `X-WR-CALNAME:${document.getElementById('show-code').value} - ${dept}`
            ];

            if (dept === 'Shoot') {
                shootingBlocks.forEach(block => {
                    block.episodes.forEach(epId => {
                        icsString.push(
                            'BEGIN:VEVENT',
                            `UID:block-${block.blockIndex}-ep${epId}@gemini.scheduler`,
                            `DTSTAMP:${formatICSDate(new Date())}`,
                            `DTSTART;VALUE=DATE:${formatICSDate(block.startDate).slice(0,8)}`,
                            `DTEND;VALUE=DATE:${formatICSDate(block.endDate, true).slice(0,8)}`,
                            `SUMMARY:[EP ${epId + 1}] Block ${block.blockIndex + 1} Shoot`,
                            `DESCRIPTION:Director: ${block.director || 'N/A'}`,
                            'END:VEVENT'
                        );
                    });
                });
            } else {
                const deptTasks = masterTaskList.filter(t => t.info.department === dept && t.isScheduled && t.info.visible);
                deptTasks.forEach(task => {
                    icsString.push(
                        'BEGIN:VEVENT',
                        `UID:${task.id}@gemini.scheduler`,
                        `DTSTAMP:${formatICSDate(new Date())}`,
                        `DTSTART;VALUE=DATE:${formatICSDate(task.scheduledStartDate).slice(0,8)}`,
                        `DTEND;VALUE=DATE:${formatICSDate(task.scheduledEndDate, true).slice(0,8)}`,
                        `SUMMARY:[EP ${task.epId + 1}] ${task.info.name}`,
                        `DESCRIPTION:Assigned Resources: ${task.resources.join(', ')}`,
                        'END:VEVENT'
                    );
                });
            }

            icsString.push('END:VCALENDAR');

            const blob = new Blob([icsString.join('\r\n')], { type: 'text/calendar' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `${generateExportFilename()}_${dept}.ics`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        });
    }


    function getExportHeaderAOA() {
        return [
            [`Show Name:`, document.getElementById('show-name').value],
            [`Version:`, document.getElementById('schedule-version').value],
            [`Created By:`, document.getElementById('created-by').value],
            [`Exported:`, getFormattedTimestamp()],
            [] // Spacer row
        ];
    }

    function exportWaterfallToExcel() {
        if (masterTaskList.length === 0) { alert("Please generate a schedule first."); return; }

        const formatDate = (date) => date ? date.toISOString().slice(0, 10) : '';
        const allDates = [];
        masterTaskList.forEach(t => {
            if (t.isScheduled) {
                allDates.push(t.scheduledStartDate, t.scheduledEndDate);
            }
        });
        getShootingBlocks().forEach(b => { allDates.push(b.startDate, b.endDate); });

        if (allDates.length === 0) { alert("No scheduled tasks to export."); return; }
        const validDates = allDates.filter(d => d && !isNaN(d.getTime()));
        if (validDates.length === 0) { alert("No valid dates found in schedule."); return; }

        const minDate = new Date(Math.min(...validDates.map(d => d.getTime())));
        const maxDate = new Date(Math.max(...validDates.map(d => d.getTime())));

        const dateRows = [];
        let currentDate = new Date(Date.UTC(minDate.getUTCFullYear(), minDate.getUTCMonth(), minDate.getUTCDate()));
        const lastDate = new Date(Date.UTC(maxDate.getUTCFullYear(), maxDate.getUTCMonth(), maxDate.getUTCDate()));

        while (currentDate <= lastDate) {
            dateRows.push(new Date(currentDate));
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }

        const aoa = getExportHeaderAOA();
        const headerRow = ['Date'];
        episodesData.forEach((ep, epId) => { headerRow.push(`EP ${epId + 1}`); });
        aoa.push(headerRow);

        dateRows.forEach(date => {
            let isHiatus = false;
            for (const hiatus of hiatuses) {
                const start = new Date(hiatus.start + 'T12:00:00Z');
                const end = new Date(hiatus.end + 'T12:00:00Z');
                if (date >= start && date <= end) {
                    isHiatus = true;
                    break;
                }
            }

            const row = [formatDate(date)];
            if (isHiatus) {
                episodesData.forEach(() => { row.push('HIATUS'); });
            } else {
                episodesData.forEach((ep, epId) => {
                    const tasksOnThisDay = [];
                    const tasksForEp = masterTaskList.filter(t => t.epId === epId && t.isScheduled && t.info.visible);
                    const shootBlocks = getShootingBlocks().filter(b => b.episodes.includes(epId));

                    tasksForEp.forEach(task => {
                        if (date >= task.scheduledStartDate && date <= task.scheduledEndDate) {
                            tasksOnThisDay.push(task.info.name);
                        }
                    });
                    shootBlocks.forEach(block => {
                        if (date >= block.startDate && date <= block.endDate) {
                            tasksOnThisDay.push(`Block ${block.blockIndex + 1} Shoot`);
                        }
                    });
                    row.push(tasksOnThisDay.join(', '));
                });
            }
            aoa.push(row);
        });

        aoa.push([]);
        aoa.push([AppDr_g0n]);

        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Waterfall Data");
        const filename = `${generateExportFilename()}_WATERFALL`;
        XLSX.writeFile(wb, `${filename}.xlsx`);
    }

    function exportGridToPDF() {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });

        doc.setFontSize(16);
        doc.text(`${document.getElementById('show-name').value} - V${document.getElementById('schedule-version').value}`, 40, 30);
        doc.setFontSize(10);
        doc.text(`Created By: ${document.getElementById('created-by').value}`, 40, 45);
        doc.text(`Generated: ${getFormattedTimestamp()}`, 40, 60);

        doc.autoTable({
            html: '#schedule-grid',
            theme: 'grid',
            startY: 75,
            styles: { fontSize: 7, cellPadding: 2 },
            headStyles: { fillColor: [241, 245, 249], textColor: [29, 41, 59], fontStyle: 'bold' },
            didParseCell: function (data) {
                if (data.row.section === 'head' && data.row.index === 0) {
                    data.cell.text = '';
                    data.cell.styles.minCellHeight = 0;
                    data.cell.styles.cellPadding = 0;
                }
            }
        });

        doc.setFontSize(8);
        doc.setTextColor(128, 128, 128);
        doc.text(AppDr_g0n, 40, doc.lastAutoTable.finalY + 20);

        const filename = `${generateExportFilename()}_GRID`;
        doc.save(`${filename}.pdf`);
    }

    function exportTimelineToExcel() {
        if (masterTaskList.length === 0) { alert("Please generate a schedule first."); return; }

        const formatDate = (date) => date ? date.toISOString().slice(0, 10) : '';

        const allDates = [];
        masterTaskList.forEach(t => {
            if (t.isScheduled) {
                allDates.push(t.scheduledStartDate, t.scheduledEndDate);
            }
        });
        getShootingBlocks().forEach(b => { allDates.push(b.startDate, b.endDate); });

        if (allDates.length === 0) { alert("No scheduled tasks to export."); return; }
        const validDates = allDates.filter(d => d && !isNaN(d.getTime()));
        if (validDates.length === 0) { alert("No valid dates found in schedule."); return; }

        const minDate = new Date(Math.min(...validDates.map(d => d.getTime())));
        const maxDate = new Date(Math.max(...validDates.map(d => d.getTime())));

        const dateColumns = [];
        let currentDate = new Date(Date.UTC(minDate.getUTCFullYear(), minDate.getUTCMonth(), minDate.getUTCDate()));
        const lastDate = new Date(Date.UTC(maxDate.getUTCFullYear(), maxDate.getUTCMonth(), maxDate.getUTCDate()));

        while (currentDate <= lastDate) {
            dateColumns.push(formatDate(currentDate));
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }

        const aoa = getExportHeaderAOA();
        const shootingBlocks = getShootingBlocks();
        const departments = ['Shoot', 'EDIT', 'MUSIC', 'VFX', 'PICTURE', 'SOUND', 'DELIVERY'];

        const header = ['Episode', 'Department / Task'];
        header.push(...dateColumns);
        aoa.push(header);

        episodesData.forEach((ep, epId) => {
            aoa.push([`EPISODE ${epId + 1}`]);

            departments.forEach(dept => {
                const row = [`EP ${epId + 1}`, dept];
                const dateValues = Array(dateColumns.length).fill('');

                if (dept === 'Shoot') {
                    shootingBlocks.forEach(block => {
                        if (block.episodes.includes(epId)) {
                            let current = new Date(block.startDate.getTime());
                            const end = new Date(block.endDate.getTime());
                            while (current <= end) {
                                const dateStr = formatDate(current);
                                const colIndex = dateColumns.indexOf(dateStr);
                                if (colIndex !== -1) {
                                    dateValues[colIndex] = 'SHOOT';
                                }
                                current.setUTCDate(current.getUTCDate() + 1);
                            }
                        }
                    });
                } else {
                    const deptTasks = masterTaskList.filter(t => t.epId === epId && t.info.department === dept && t.isScheduled && t.info.visible);
                    deptTasks.forEach(task => {
                        let current = new Date(task.scheduledStartDate.getTime());
                        const end = new Date(task.scheduledEndDate.getTime());
                        while (current <= end) {
                            const dateStr = formatDate(current);
                            const colIndex = dateColumns.indexOf(dateStr);
                            if (colIndex !== -1) {
                                dateValues[colIndex] = (dateValues[colIndex] ? dateValues[colIndex] + ', ' : '') + task.info.name;
                            }
                            current.setUTCDate(current.getUTCDate() + 1);
                        }
                    });
                }
                row.push(...dateValues);
                aoa.push(row);
            });

            aoa.push([]);
        });

        aoa.push([]);
        aoa.push([AppDr_g0n]);

        const ws = XLSX.utils.aoa_to_sheet(aoa);

        const colWidths = [ { wch: 10 }, { wch: 25 } ];
        dateColumns.forEach(() => colWidths.push({ wch: 18 }));
        ws['!cols'] = colWidths;

        const merges = [];
        let headerOffset = 5;
        let currentRow = headerOffset;
        episodesData.forEach(() => {
            merges.push({ s: { r: currentRow, c: 0 }, e: { r: currentRow, c: header.length - 1 } });
            currentRow += (departments.length + 1);
            currentRow++;
        });
        ws['!merges'] = merges;

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Timeline Export");
        const filename = `${generateExportFilename()}_TIMELINE`;
        XLSX.writeFile(wb, `${filename}.xlsx`);
    }

    function saveSchedule() {
        const cleanEpisodesData = episodesData.map(ep => ({
            editors: ep.editors,
            director: ep.director,
            blockWrapDate: ep.blockWrapDate
        }));

        const state = {
            inputs: {},
            tasks: masterTaskList,
            episodes: cleanEpisodesData,
            hiatuses: hiatuses,
            sixthDayWorkDates: sixthDayWorkDates,
            budget: budgetData,
            gridVisibleColumns: gridVisibleColumns
        };

        document.querySelectorAll('.controls input, .controls select, .schedule-variables input, .personnel-assignments input, .personnel-assignments select, .block-assignments input, .holiday-settings input, .holiday-settings select, #budget-view input, #budget-view select').forEach(el => {
            if (el.type === 'checkbox') {
                state.inputs[el.id] = el.checked;
            } else if(el.type === 'select-multiple') {
                state.inputs[el.id] = Array.from(el.selectedOptions).map(opt => opt.value);
            }
            else {
                state.inputs[el.id] = el.value;
            }
        });

        const dataStr = JSON.stringify(state, (key, value) => {
            if (key === 'predecessors' || key === 'originalPredecessors') {
                 if (!value) return [];
                 return value.filter(p => p && p.task).map(p => ({...p, task: p.task.id}));
            }
            return value;
        }, 2);

        const blob = new Blob([dataStr], {type: "application/json"});
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${generateExportFilename()}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
    }
    function exportBudgetToExcel() {
        if (typeof XLSX === 'undefined') {
            alert('Excel export library not loaded. Please refresh and try again.');
            return;
        }
        
        const wb = XLSX.utils.book_new();
        
        // Build comprehensive labor mapping with multiple lookup keys
        const laborMapping = {};
        const laborDescToRow = {};
        let laborStartRow = 2;
        
        if (budgetData['Labor']) {
            budgetData['Labor'].forEach((item, index) => {
                const excelRow = laborStartRow + index;
                
                // Store by ID
                laborMapping[item.id] = {
                    row: excelRow,
                    desc: item.desc,
                    num: item.num,
                    prep: item.prep,
                    shoot: item.shoot,
                    post: item.post,
                    wrap: item.wrap
                };
                
                // Store by description variations for fallback matching
                const descKey = item.desc.toLowerCase().trim();
                laborDescToRow[descKey] = excelRow;
                
                // Also store without common suffixes for easier matching
                const baseName = descKey
                    .replace(/\s*\(.*\)/, '') // Remove parenthetical
                    .replace(/\s*-.*/, ''); // Remove dash suffixes
                if (baseName !== descKey) {
                    laborDescToRow[baseName] = excelRow;
                }
                
                // Store common abbreviations
                if (descKey.includes('assistant')) {
                    laborDescToRow[descKey.replace('assistant', 'asst')] = excelRow;
                    laborDescToRow[descKey.replace('assistant', 'ast')] = excelRow;
                }
                if (descKey.includes('producer')) {
                    laborDescToRow[descKey.replace('producer', 'prod')] = excelRow;
                }
                if (descKey.includes('coordinator')) {
                    laborDescToRow[descKey.replace('coordinator', 'coord')] = excelRow;
                }
            });
        }
        
        // Helper function to find labor reference with comprehensive matching
        const findLaborReference = (item) => {
            // First check laborRef if it exists
            if (item.laborRef && laborMapping[item.laborRef]) {
                return laborMapping[item.laborRef];
            }
            
            const itemDesc = (item.desc || '').toLowerCase().trim();
            
            // Direct description match
            if (laborDescToRow[itemDesc]) {
                return {
                    row: laborDescToRow[itemDesc],
                    desc: itemDesc
                };
            }
            
            // Pattern matching for rooms/equipment/box rentals
            const patterns = [
                { pattern: /^(.+?)\s+room$/i, captureGroup: 1 },
                { pattern: /^(.+?)\s+equipment$/i, captureGroup: 1 },
                { pattern: /^(.+?)\s+box\s+rental$/i, captureGroup: 1 },
                { pattern: /^(.+?)'s\s+room$/i, captureGroup: 1 },
                { pattern: /^(.+?)'s\s+equipment$/i, captureGroup: 1 },
                { pattern: /^(.+?)'s\s+box\s+rental$/i, captureGroup: 1 },
                { pattern: /^room\s+for\s+(.+?)$/i, captureGroup: 1 },
                { pattern: /^equipment\s+for\s+(.+?)$/i, captureGroup: 1 },
                { pattern: /^box\s+rental\s+for\s+(.+?)$/i, captureGroup: 1 }
            ];
            
            for (let pattern of patterns) {
                const match = itemDesc.match(pattern.pattern);
                if (match && match[pattern.captureGroup]) {
                    const baseName = match[pattern.captureGroup].toLowerCase().trim();
                    if (laborDescToRow[baseName]) {
                        return {
                            row: laborDescToRow[baseName],
                            desc: baseName
                        };
                    }
                }
            }
            
            // Fuzzy matching - find partial matches
            for (let laborDesc in laborDescToRow) {
                // Check if item description contains labor description or vice versa
                if (itemDesc.includes(laborDesc) || laborDesc.includes(itemDesc)) {
                    return {
                        row: laborDescToRow[laborDesc],
                        desc: laborDesc
                    };
                }
                
                // Check for common word overlap
                const itemWords = itemDesc.split(/\s+/);
                const laborWords = laborDesc.split(/\s+/);
                const commonWords = itemWords.filter(word => 
                    laborWords.includes(word) && word.length > 3
                );
                if (commonWords.length >= 2) {
                    return {
                        row: laborDescToRow[laborDesc],
                        desc: laborDesc
                    };
                }
            }
            
            return null;
        };
        
        // Create summary sheet
        const summaryData = [
            ['Budget Export - ' + document.getElementById('show-name').value],
            ['Generated: ' + new Date().toLocaleDateString()],
            ['Created with TV Post Production Scheduler'],
            [AppDr_g0n],
            [''],
            ['Category', 'Subtotal']
        ];
        
        let summaryRow = 7;
        const categoryRows = {};
        
        Object.keys(budgetData).forEach(category => {
            categoryRows[category] = summaryRow;
            summaryData.push([category, '']);
            summaryRow++;
        });
        
        summaryData.push(['', '']);
        summaryData.push(['GRAND TOTAL', { t: 'n', f: `SUM(B7:B${summaryRow - 1})` }]);
        
        const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
        XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');
        
        // Process each category
        Object.keys(budgetData).forEach(category => {
            const categoryData = [];
            let currentRow = 1;
            
            // Add headers based on category type
            if (category === "Labor" || category === "Fabrication") {
                categoryData.push(['Description', 'Qty', 'Prep', 'Shoot', 'Post', 'Wrap', 'Total Wks', 'Rate', 'Fringe Type', 'Fringe Rate', 'Labor Total', 'Fringe Total', 'Total']);
            } else if (category === "Rooms" || category === "Equipment Rentals") {
                categoryData.push(['Description', 'Qty', 'Prep', 'Shoot', 'Post', 'Wrap', 'Total Wks', 'Rate', 'Total', 'Labor Link']);
            } else if (category === "Box Rentals") {
                categoryData.push(['Description', 'Qty', 'Prep', 'Shoot', 'Post', 'Wrap', 'Total Wks', 'Rate', 'Fringe Capped', 'Fringe Cap', 'Total', 'Labor Link']);
            }
            currentRow++;
            
            // Process each item in the category
            budgetData[category].forEach((item, index) => {
                const rowNum = currentRow + index;
                
                if (category === "Labor" || category === "Fabrication") {
                    categoryData.push([
                        item.desc || '',
                        item.num || 0,
                        item.prep || 0,
                        item.shoot || 0,
                        item.post || 0,
                        item.wrap || 0,
                        { t: 'n', f: `C${rowNum}+D${rowNum}+E${rowNum}+F${rowNum}` },
                        item.rate || 0,
                        item.fringeType || 'percent',
                        item.fringeRate || 0,
                        { t: 'n', f: `B${rowNum}*G${rowNum}*H${rowNum}` },
                        { t: 'n', f: `IF(I${rowNum}="percent",K${rowNum}*J${rowNum}/100,IF(I${rowNum}="flat",J${rowNum}*G${rowNum}*B${rowNum},0))` },
                        { t: 'n', f: `K${rowNum}+L${rowNum}` }
                    ]);
                } else if (category === "Rooms" || category === "Equipment Rentals") {
                    const laborLink = findLaborReference(item);
                    if (laborLink) {
                        categoryData.push([
                            item.desc || '',
                            { t: 'n', f: `Labor!B${laborLink.row}` },
                            { t: 'n', f: `Labor!C${laborLink.row}` },
                            { t: 'n', f: `Labor!D${laborLink.row}` },
                            { t: 'n', f: `Labor!E${laborLink.row}` },
                            { t: 'n', f: `Labor!F${laborLink.row}` },
                            { t: 'n', f: `C${rowNum}+D${rowNum}+E${rowNum}+F${rowNum}` },
                            item.rate || 0,
                            { t: 'n', f: `B${rowNum}*G${rowNum}*H${rowNum}` },
                            laborLink.desc || ''
                        ]);
                    } else {
                        categoryData.push([
                            item.desc || '',
                            item.num || 0,
                            item.prep || 0,
                            item.shoot || 0,
                            item.post || 0,
                            item.wrap || 0,
                            { t: 'n', f: `C${rowNum}+D${rowNum}+E${rowNum}+F${rowNum}` },
                            item.rate || 0,
                            { t: 'n', f: `B${rowNum}*G${rowNum}*H${rowNum}` },
                            ''
                        ]);
                    }
                } else if (category === "Box Rentals") {
                    const laborLink = findLaborReference(item);
                    if (laborLink) {
                        categoryData.push([
                            item.desc || '',
                            { t: 'n', f: `Labor!B${laborLink.row}` },
                            { t: 'n', f: `Labor!C${laborLink.row}` },
                            { t: 'n', f: `Labor!D${laborLink.row}` },
                            { t: 'n', f: `Labor!E${laborLink.row}` },
                            { t: 'n', f: `Labor!F${laborLink.row}` },
                            { t: 'n', f: `C${rowNum}+D${rowNum}+E${rowNum}+F${rowNum}` },
                            item.rate || 0,
                            item.fringeType === 'capped' ? 'Yes' : 'No',
                            item.fringeRate || 0,
                            { t: 'n', f: `B${rowNum}*G${rowNum}*H${rowNum}+IF(I${rowNum}="Yes",MIN(B${rowNum}*G${rowNum}*H${rowNum}*0.25,J${rowNum}),0)` },
                            laborLink.desc || ''
                        ]);
                    } else {
                        categoryData.push([
                            item.desc || '',
                            item.num || 0,
                            item.prep || 0,
                            item.shoot || 0,
                            item.post || 0,
                            item.wrap || 0,
                            { t: 'n', f: `C${rowNum}+D${rowNum}+E${rowNum}+F${rowNum}` },
                            item.rate || 0,
                            item.fringeType === 'capped' ? 'Yes' : 'No',
                            item.fringeRate || 0,
                            { t: 'n', f: `B${rowNum}*G${rowNum}*H${rowNum}+IF(I${rowNum}="Yes",MIN(B${rowNum}*G${rowNum}*H${rowNum}*0.25,J${rowNum}),0)` },
                            ''
                        ]);
                    }
                }
            });
            
            // Add subtotal row
            const dataEndRow = currentRow + budgetData[category].length - 1;
            const subtotalRow = new Array(categoryData[0].length - 2).fill('');
            
            let totalColumn;
            if (category === "Labor" || category === "Fabrication") {
                totalColumn = 'M';
            } else if (category === "Rooms" || category === "Equipment Rentals") {
                totalColumn = 'I';
            } else if (category === "Box Rentals") {
                totalColumn = 'K';
            }
            
            subtotalRow.push('Subtotal');
            subtotalRow.push({ t: 'n', f: `SUM(${totalColumn}2:${totalColumn}${dataEndRow})` });
            categoryData.push(subtotalRow);
            
            const categorySheet = XLSX.utils.aoa_to_sheet(categoryData);
            const sheetName = category.substring(0, 31).replace(/[\\\/\?\*\[\]]/g, '');
            XLSX.utils.book_append_sheet(wb, categorySheet, sheetName);
            
            // Update summary reference
            const subtotalRowNum = dataEndRow + 1;
            summarySheet['B' + categoryRows[category]] = { t: 'n', f: `'${sheetName}'!${totalColumn}${subtotalRowNum}` };
        });
        
        const showName = document.getElementById('show-name').value || 'Schedule';
        const showCode = document.getElementById('show-code').value || 'SHOW';
        const filename = `${showCode}_Budget_${new Date().toISOString().split('T')[0]}.xlsx`;
        
        XLSX.writeFile(wb, filename);
    }
    
    // Helper function for calculating category totals in the web app
    function calculateCategoryTotal(category) {
        let total = 0;
        budgetData[category].forEach(item => {
            const totalWeeks = (item.prep || 0) + (item.shoot || 0) + (item.post || 0) + (item.wrap || 0);
            const laborTotal = (item.num || 0) * totalWeeks * (item.rate || 0);
            
            let fringeTotal = 0;
            if (category !== "Rooms" && category !== "Equipment Rentals") {
                if (item.fringeType === 'percent') {
                    fringeTotal = laborTotal * ((item.fringeRate || 0) / 100);
                } else if (item.fringeType === 'flat') {
                    fringeTotal = (item.fringeRate || 0) * totalWeeks * (item.num || 0);
                } else if (item.fringeType === 'capped' && category === "Box Rentals") {
                    fringeTotal = Math.min(laborTotal * 0.25, item.fringeRate || 0);
                }
            }
            
            total += laborTotal + fringeTotal;
        });
        return total;
    }
    function showAddLaborModal() {
        const modal = document.getElementById('add-labor-modal');
        if (!modal) {
            console.error('Add labor modal not found in DOM');
            return;
        }
        
        modal.style.display = 'flex';
        
        // Clear all previous values and reset to defaults
        document.getElementById('new-labor-desc').value = '';
        document.getElementById('new-labor-qty').value = '1';
        document.getElementById('new-labor-rate').value = '0';
        document.getElementById('new-labor-prep').value = '0';
        document.getElementById('new-labor-shoot').value = '0';
        document.getElementById('new-labor-post').value = '0';
        document.getElementById('new-labor-wrap').value = '0';
        document.getElementById('new-labor-fringe-type').value = 'percent';
        document.getElementById('new-labor-fringe-rate').value = '25';
        document.getElementById('create-room').checked = true;
        document.getElementById('create-equipment').checked = true;
        document.getElementById('create-box-rental').checked = true;
        
        // Confirm button handler
        document.getElementById('confirm-add-labor').onclick = () => {
            // Gather all the input values
            const desc = document.getElementById('new-labor-desc').value.trim() || 'New Crew Member';
            const qty = parseFloat(document.getElementById('new-labor-qty').value) || 1;
            const rate = parseFloat(document.getElementById('new-labor-rate').value) || 0;
            const prep = parseFloat(document.getElementById('new-labor-prep').value) || 0;
            const shoot = parseFloat(document.getElementById('new-labor-shoot').value) || 0;
            const post = parseFloat(document.getElementById('new-labor-post').value) || 0;
            const wrap = parseFloat(document.getElementById('new-labor-wrap').value) || 0;
            const fringeType = document.getElementById('new-labor-fringe-type').value || 'percent';
            const fringeRate = parseFloat(document.getElementById('new-labor-fringe-rate').value) || 0;
            
            // Create the labor item with all values
            const laborItem = {
                id: generateUUID(),
                desc: desc,
                num: qty,
                prep: prep,
                shoot: shoot,
                post: post,
                wrap: wrap,
                rate: rate,
                fringeType: fringeType,
                fringeRate: fringeRate
            };
            
            // Add to budget data
            if (!budgetData['Labor']) {
                budgetData['Labor'] = [];
            }
            budgetData['Labor'].push(laborItem);
            
            // Create related items if checkboxes are checked
            if (document.getElementById('create-room').checked) {
                if (!budgetData['Rooms']) {
                    budgetData['Rooms'] = [];
                }
                budgetData['Rooms'].push({
                    id: generateUUID(),
                    desc: `${desc} Room`,
                    num: qty,
                    prep: prep,
                    shoot: shoot,
                    post: post,
                    wrap: wrap,
                    rate: 0, // User can set this later
                    laborRef: laborItem.id
                });
            }
            
            if (document.getElementById('create-equipment').checked) {
                if (!budgetData['Equipment Rentals']) {
                    budgetData['Equipment Rentals'] = [];
                }
                budgetData['Equipment Rentals'].push({
                    id: generateUUID(),
                    desc: `${desc} Equipment`,
                    num: qty,
                    prep: prep,
                    shoot: shoot,
                    post: post,
                    wrap: wrap,
                    rate: 0, // User can set this later
                    laborRef: laborItem.id
                });
            }
            
            if (document.getElementById('create-box-rental').checked) {
                if (!budgetData['Box Rentals']) {
                    budgetData['Box Rentals'] = [];
                }
                budgetData['Box Rentals'].push({
                    id: generateUUID(),
                    desc: `${desc} Box Rental`,
                    num: qty,
                    prep: prep,
                    shoot: shoot,
                    post: post,
                    wrap: wrap,
                    rate: 0, // User can set this later
                    fringeType: 'none',
                    fringeRate: 0,
                    laborRef: laborItem.id
                });
            }
            
            // Close modal and re-render
            modal.style.display = 'none';
            renderBudgetView();
        };
        
        // Cancel button handler
        document.getElementById('cancel-add-labor').onclick = () => {
            modal.style.display = 'none';
        };
        
        // Close X button handler
        document.getElementById('add-labor-modal-close').onclick = () => {
            modal.style.display = 'none';
        };
        
        // Click outside modal to close
        modal.onclick = (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
            }
        };
    }
    function loadSchedule() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.readAsText(file, 'UTF-8');
            reader.onload = readerEvent => {
                try {
                    const content = readerEvent.target.result;
                    const state = JSON.parse(content);

                    hiatuses = state.hiatuses || [];
                    sixthDayWorkDates = state.sixthDayWorkDates || [];
                    budgetData = state.budget || {};

                    for (const id in state.inputs) {
                        const el = document.getElementById(id);
                        if (el) {
                             if (el.type === 'checkbox') el.checked = state.inputs[id];
                             else if (el.type !== 'select-multiple') el.value = state.inputs[id];
                        }
                    }

                    generatePersonnelFields();
                    generateStudioCutFields();
                    generateBlockFields();
                    generateHolidaySelectors();

                     for (const id in state.inputs) {
                        const el = document.getElementById(id);
                        if (el) {
                            if (el.type === 'select-multiple') {
                                const values = state.inputs[id];
                                Array.from(el.options).forEach(opt => {
                                    opt.selected = values.includes(opt.value);
                                });
                            } else if(el.closest('.holiday-region-group')) {
                                el.checked = state.inputs[id];
                            }
                        }
                    }

                    if (state.tasks) {
                        state.tasks.forEach(task => {
                            if (task.scheduledStartDate) task.scheduledStartDate = new Date(task.scheduledStartDate);
                            if (task.scheduledEndDate) task.scheduledEndDate = new Date(task.scheduledEndDate);
                            if (task.potentialStartDate) task.potentialStartDate = new Date(task.potentialStartDate);
                        });
                        masterTaskList = state.tasks;
                        const taskMap = new Map(masterTaskList.map(t => [t.id, t]));

                        masterTaskList.forEach(task => {
                            if(task.predecessors) {
                                task.predecessors = task.predecessors.map(p => ({...p, task: taskMap.get(p.task)})).filter(p => p.task);
                            }
                             if(task.originalPredecessors) {
                                task.originalPredecessors = task.originalPredecessors.map(p => ({...p, task: taskMap.get(p.task)})).filter(p => p.task);
                            }
                        });
                    }

                    gridVisibleColumns = state.gridVisibleColumns || getCurrentAllGridColumns();

                    updateWrapDate();
                    renderHiatusList();
                    renderSixthDayList();
                    calculateAndRender();

                } catch(err) {
                    alert("Error loading file. It may be invalid or corrupted.");
                    console.error("Load schedule error:", err);
                }
            }
        }
        input.click();
    }
    
    function addFreeTask(epId, department, startDate, name, duration, assignee) {
        if (!name || !name.trim()) return;

        const newTask = {
            id: `ep${epId}-freetask-${generateUUID()}`,
            epId: parseInt(epId),
            info: {
                name: name.trim(),
                duration: duration,
                department: department.toUpperCase(),
                visible: true,
                priority: 100
            },
            predecessors: [],
            originalPredecessors: [],
            resources: assignee ? [assignee] : [],
            isScheduled: true,
            isManuallySet: true,
            scheduledStartDate: startDate,
            scheduledEndDate: addBusinessDays(startDate, duration, department.toUpperCase())
        };

        masterTaskList.push(newTask);
        if(!episodesData[epId].tasks) {
            episodesData[epId].tasks = [];
        }
        episodesData[epId].tasks.push(newTask);

        calculateAndRender();
    }

    function setupModal() {
        const modal = document.getElementById('event-modal');
        const openBtn = document.getElementById('create-new-event-btn');
        const closeBtn = document.getElementById('modal-close-btn');
        const cancelBtn = document.getElementById('modal-cancel-btn');
        const form = document.getElementById('event-form');
        const episodeSelect = document.getElementById('task-episode');
        const departmentSelect = document.getElementById('task-department');
        const modalTitle = document.getElementById('modal-title');
        const submitBtn = document.getElementById('modal-submit-btn');
        const deleteBtn = document.getElementById('modal-delete-btn');
        const editTaskIdInput = document.getElementById('edit-task-id');
        const manageModal = document.getElementById('manage-events-modal');


        const openModalForCreate = () => {
            form.reset();
            editTaskIdInput.value = '';
            modalTitle.textContent = 'Create New Event';
            submitBtn.textContent = 'Create Event';
            deleteBtn.style.display = 'none';

            episodeSelect.innerHTML = '';
            for (let i = 0; i < episodesData.length; i++) {
                episodeSelect.innerHTML += `<option value="${i}">EP ${i+1}</option>`;
            }

            departmentSelect.innerHTML = '';
            const departments = ['EDIT', 'MUSIC', 'VFX', 'PICTURE', 'SOUND', 'DELIVERY'];
            departments.forEach(dept => {
                departmentSelect.innerHTML += `<option value="${dept}">${dept}</option>`;
            });

            modal.style.display = 'flex';
        };

        const openModalForEdit = (task) => {
            form.reset();
            editTaskIdInput.value = task.id;
            modalTitle.textContent = 'Edit Event';
            submitBtn.textContent = 'Save Changes';
            deleteBtn.style.display = 'block';

            document.getElementById('task-name').value = task.info.name;
            document.getElementById('task-start-date').value = toYYYYMMDD(task.scheduledStartDate);
            document.getElementById('task-duration').value = task.info.duration;
            document.getElementById('task-assignee').value = task.resources.join(', ');

            episodeSelect.innerHTML = '';
            for (let i = 0; i < episodesData.length; i++) {
                episodeSelect.innerHTML += `<option value="${i}" ${i === task.epId ? 'selected' : ''}>EP ${i+1}</option>`;
            }

            departmentSelect.innerHTML = '';
            const departments = ['EDIT', 'MUSIC', 'VFX', 'PICTURE', 'SOUND', 'DELIVERY'];
            departments.forEach(dept => {
                departmentSelect.innerHTML += `<option value="${dept}" ${dept === task.info.department ? 'selected' : ''}>${dept}</option>`;
            });

            manageModal.style.display = 'none';
            modal.style.display = 'flex';
        };

        const closeModal = () => {
            modal.style.display = 'none';
        };

        const closeManageModal = () => {
            manageModal.style.display = 'none';
        }

        openBtn.addEventListener('click', openModalForCreate);
        closeBtn.addEventListener('click', closeModal);
        cancelBtn.addEventListener('click', closeModal);
        window.addEventListener('click', (e) => {
            if(e.target === modal) closeModal();
            if(e.target === manageModal) closeManageModal();
        });

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const taskId = editTaskIdInput.value;
            const taskName = document.getElementById('task-name').value;
            const epId = parseInt(document.getElementById('task-episode').value);
            const department = document.getElementById('task-department').value;
            const startDate = new Date(document.getElementById('task-start-date').value + 'T12:00:00Z');
            const duration = parseInt(document.getElementById('task-duration').value);
            const assignee = document.getElementById('task-assignee').value;

            if (taskId) {
                const taskIndex = masterTaskList.findIndex(t => t.id === taskId);
                if (taskIndex > -1) {
                    const taskToUpdate = masterTaskList[taskIndex];
                    const originalEpId = taskToUpdate.epId;

                    taskToUpdate.info.name = taskName;
                    taskToUpdate.epId = epId;
                    taskToUpdate.info.department = department;
                    taskToUpdate.scheduledStartDate = startDate;
                    taskToUpdate.info.duration = duration;
                    taskToUpdate.resources = assignee ? [assignee] : [];
                    taskToUpdate.scheduledEndDate = addBusinessDays(startDate, duration, department);

                    if (originalEpId !== epId) {
                        const originalEpTasks = episodesData[originalEpId].tasks;
                        const taskEpIndex = originalEpTasks.findIndex(t => t.id === taskId);
                        if (taskEpIndex > -1) {
                            const [taskToMove] = originalEpTasks.splice(taskEpIndex, 1);
                            episodesData[epId].tasks.push(taskToMove);
                        }
                    }
                    calculateAndRender();
                }
            } else {
                addFreeTask(epId, department, startDate, taskName, duration, assignee);
            }

            closeModal();
        });

        deleteBtn.addEventListener('click', () => {
            const taskId = editTaskIdInput.value;
            if (!taskId) return;

            const taskIndex = masterTaskList.findIndex(t => t.id === taskId);
            if (taskIndex > -1) {
                const taskToDelete = masterTaskList[taskIndex];
                masterTaskList.splice(taskIndex, 1);
                const epTaskIndex = episodesData[taskToDelete.epId].tasks.findIndex(t => t.id === taskId);
                if (epTaskIndex > -1) {
                    episodesData[taskToDelete.epId].tasks.splice(epTaskIndex, 1);
                }
            }

            calculateAndRender();
            closeModal();
        });

        const manageBtn = document.getElementById('manage-events-btn');
        const manageModalCloseBtn = document.getElementById('manage-modal-close-btn');
        const customEventList = document.getElementById('custom-event-list');

        manageBtn.addEventListener('click', () => {
            customEventList.innerHTML = '';
            const customTasks = masterTaskList.filter(t => t.id.includes('freetask'));

            if (customTasks.length === 0) {
                customEventList.innerHTML = '<p>No custom events have been created yet.</p>';
            } else {
                customTasks.forEach(task => {
                    const item = document.createElement('div');
                    item.className = 'custom-event-item';
                    item.innerHTML = `
                        <div class="custom-event-info">
                            <strong>${task.info.name}</strong> (EP ${task.epId + 1} - ${task.info.department})<br>
                            <small>${task.scheduledStartDate.toLocaleDateString()}</small>
                        </div>
                        <div class="custom-event-buttons">
                            <button class="edit-custom-event-btn primary-action" data-task-id="${task.id}">Edit</button>
                            <button class="delete-custom-event-btn delete-button" data-task-id="${task.id}">Delete</button>
                        </div>
                    `;
                    customEventList.appendChild(item);
                });
            }
            manageModal.style.display = 'flex';
        });

        manageModalCloseBtn.addEventListener('click', closeManageModal);

        customEventList.addEventListener('click', (e) => {
            const taskId = e.target.dataset.taskId;
            if (!taskId) return;

            const task = masterTaskList.find(t => t.id === taskId);
            if (!task) return;

            if (e.target.classList.contains('edit-custom-event-btn')) {
                openModalForEdit(task);
            } else if (e.target.classList.contains('delete-custom-event-btn')) {
                const taskIndex = masterTaskList.findIndex(t => t.id === taskId);
                if (taskIndex > -1) {
                    masterTaskList.splice(taskIndex, 1);
                    const epTaskIndex = episodesData[task.epId].tasks.findIndex(t => t.id === taskId);
                    if (epTaskIndex > -1) {
                        episodesData[task.epId].tasks.splice(epTaskIndex, 1);
                    }
                }
                calculateAndRender();
                closeManageModal();
            }
        });
    }

    function initializeDefaultHiatus() {
        const sopValue = document.getElementById('start-of-photography').value;
        const year = sopValue ? new Date(sopValue).getFullYear() : new Date().getFullYear();
        hiatuses = [{
            id: generateUUID(),
            name: 'Holiday Hiatus',
            start: `${year}-12-22`,
            end: `${year + 1}-01-04`,
        }];
        renderHiatusList();
    }

    function renderHiatusList() {
        const container = document.getElementById('hiatus-list');
        container.innerHTML = '';
        hiatuses.forEach(hiatus => {
            const item = document.createElement('div');
            item.className = 'custom-event-item';
            item.innerHTML = `
                <div class="custom-event-info">
                    <strong>${hiatus.name}</strong><br>
                    <small>${hiatus.start} to ${hiatus.end}</small>
                </div>
                <div class="custom-event-buttons">
                    <button class="edit-hiatus-btn primary-action" data-hiatus-id="${hiatus.id}">Edit</button>
                    <button class="delete-hiatus-btn delete-button" data-hiatus-id="${hiatus.id}">Delete</button>
                </div>`;
            container.appendChild(item);
        });
    }

    function setupHiatusModal() {
        const modal = document.getElementById('hiatus-modal');
        const openBtn = document.getElementById('add-hiatus-btn');
        const closeBtn = document.getElementById('hiatus-modal-close-btn');
        const cancelBtn = document.getElementById('hiatus-modal-cancel-btn');
        const form = document.getElementById('hiatus-form');
        const modalTitle = document.getElementById('hiatus-modal-title');
        const submitBtn = document.getElementById('hiatus-modal-submit-btn');
        const deleteBtn = document.getElementById('hiatus-modal-delete-btn');
        const editIdInput = document.getElementById('edit-hiatus-id');
        const listContainer = document.getElementById('hiatus-list');

        const openModal = (hiatus = null) => {
            form.reset();
            if (hiatus) {
                editIdInput.value = hiatus.id;
                modalTitle.textContent = 'Edit Hiatus';
                submitBtn.textContent = 'Save Changes';
                deleteBtn.style.display = 'block';
                document.getElementById('hiatus-name').value = hiatus.name;
                document.getElementById('hiatus-start-date').value = hiatus.start;
                document.getElementById('hiatus-end-date').value = hiatus.end;
            } else {
                editIdInput.value = '';
                modalTitle.textContent = 'Add Hiatus';
                submitBtn.textContent = 'Add Hiatus';
                deleteBtn.style.display = 'none';
            }
            modal.style.display = 'flex';
        };

        const closeModal = () => {
            modal.style.display = 'none';
        };

        openBtn.addEventListener('click', () => openModal());
        closeBtn.addEventListener('click', closeModal);
        cancelBtn.addEventListener('click', closeModal);
        deleteBtn.addEventListener('click', () => {
            const id = editIdInput.value;
            hiatuses = hiatuses.filter(h => h.id !== id);
            renderHiatusList();
            calculateAndRender();
            closeModal();
        });

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const id = editIdInput.value;
            const newHiatus = {
                id: id || generateUUID(),
                name: document.getElementById('hiatus-name').value,
                start: document.getElementById('hiatus-start-date').value,
                end: document.getElementById('hiatus-end-date').value,
            };

            if (newHiatus.start >= newHiatus.end) {
                alert("Hiatus end date must be after the start date.");
                return;
            }

            if (id) {
                const index = hiatuses.findIndex(h => h.id === id);
                if (index > -1) hiatuses[index] = newHiatus;
            } else {
                hiatuses.push(newHiatus);
            }
            renderHiatusList();
            calculateAndRender();
            closeModal();
        });

        listContainer.addEventListener('click', (e) => {
            const target = e.target;
            const id = target.dataset.hiatusId;
            if (!id) return;

            if (target.classList.contains('edit-hiatus-btn')) {
                const hiatus = hiatuses.find(h => h.id === id);
                if (hiatus) openModal(hiatus);
            } else if (target.classList.contains('delete-hiatus-btn')) {
                hiatuses = hiatuses.filter(h => h.id !== id);
                renderHiatusList();
                calculateAndRender();
            }
        });
    }

    function renderSixthDayList() {
        const container = document.getElementById('sixth-day-list');
        container.innerHTML = '';
        if (sixthDayWorkDates.length === 0) {
            container.innerHTML = '<p>No 6th day work scheduled.</p>';
            return;
        }
        sixthDayWorkDates.sort((a,b) => new Date(a.date) - new Date(b.date)).forEach(auth => {
            const item = document.createElement('div');
            item.className = 'custom-event-item';
            let scopeText = `For: ${auth.scope === 'all' ? 'Entire Schedule' : auth.scope === 'episode' ? `EP ${parseInt(auth.value) + 1}` : auth.value}`;

            item.innerHTML = `
                <div class="custom-event-info">
                    <strong>${auth.date}</strong><br>
                    <small>${scopeText}</small>
                </div>
                <div class="custom-event-buttons">
                    <button class="delete-sixth-day-btn delete-button" data-id="${auth.id}">Delete</button>
                </div>`;
            container.appendChild(item);
        });
    }

    function setupSixthDayModal() {
        const modal = document.getElementById('sixth-day-modal');
        const openBtn = document.getElementById('add-sixth-day-btn');
        const closeBtn = document.getElementById('sixth-day-modal-close-btn');
        const cancelBtn = document.getElementById('sixth-day-modal-cancel-btn');
        const form = document.getElementById('sixth-day-form');
        const scopeSelect = document.getElementById('sixth-day-scope');
        const valueGroup = document.getElementById('sixth-day-value-group');
        const valueSelect = document.getElementById('sixth-day-value-select');
        const dateInput = document.getElementById('sixth-day-date');
        const listContainer = document.getElementById('sixth-day-list');

        const openModal = () => {
            form.reset();
            updateValueSelect();
            modal.style.display = 'flex';
        };

        const closeModal = () => {
            modal.style.display = 'none';
        };

        const updateValueSelect = () => {
            const scope = scopeSelect.value;
            valueGroup.style.display = 'none';
            valueSelect.innerHTML = '';

            if (scope === 'episode') {
                valueGroup.style.display = 'block';
                const numEpisodes = parseInt(document.getElementById('num-episodes').value) || 0;
                for (let i = 0; i < numEpisodes; i++) {
                    valueSelect.innerHTML += `<option value="${i}">EP ${i + 1}</option>`;
                }
            } else if (scope === 'resource') {
                valueGroup.style.display = 'block';
                const allPersonnel = new Set();
                for (let i = 0; i < (parseInt(document.getElementById('num-editors').value) || 0); i++) {
                    const name = document.getElementById(`editor-name-${i}`).value;
                    if(name) allPersonnel.add(name);
                }
                for (let i = 0; i < (parseInt(document.getElementById('num-directors').value) || 0); i++) {
                    const name = document.getElementById(`director-name-${i}`).value;
                    if(name) allPersonnel.add(name);
                }
                allPersonnel.forEach(p => {
                    valueSelect.innerHTML += `<option value="${p}">${p}</option>`;
                });
            }
        };

        openBtn.addEventListener('click', openModal);
        closeBtn.addEventListener('click', closeModal);
        cancelBtn.addEventListener('click', closeModal);
        scopeSelect.addEventListener('change', updateValueSelect);

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const date = dateInput.value;
            const scope = scopeSelect.value;
            const value = (scope === 'all') ? null : valueSelect.value;

            if (!date) {
                alert('Please select a date.');
                return;
            }

            const newAuth = { id: generateUUID(), date, scope, value };
            sixthDayWorkDates.push(newAuth);
            renderSixthDayList();
            calculateAndRender();
            closeModal();
        });

        listContainer.addEventListener('click', (e) => {
            if (e.target.classList.contains('delete-sixth-day-btn')) {
                const idToDelete = e.target.dataset.id;
                sixthDayWorkDates = sixthDayWorkDates.filter(d => d.id !== idToDelete);
                renderSixthDayList();
                calculateAndRender();
            }
        });
    }

    function setupColumnConfigModal() {
        const modal = document.getElementById('grid-column-modal');
        const openBtn = document.getElementById('configure-grid-export-btn');
        const closeBtn = document.getElementById('grid-column-modal-close-btn');
        const cancelBtn = document.getElementById('grid-column-modal-cancel-btn');
        const saveBtn = document.getElementById('grid-column-modal-save-btn');
        const checkboxContainer = document.getElementById('grid-column-checkboxes');

        openBtn.addEventListener('click', () => {
            checkboxContainer.innerHTML = '';
            const currentCols = getCurrentAllGridColumns();
            currentCols.forEach(colName => {
                const isChecked = gridVisibleColumns.includes(colName);
                const checkboxId = `col-toggle-${colName.replace(/[^a-zA-Z0-9]/g, '-')}`;
                const item = document.createElement('div');
                item.innerHTML = `
                    <label for="${checkboxId}">
                        <input type="checkbox" id="${checkboxId}" value="${colName}" ${isChecked ? 'checked' : ''}>
                        ${colName}
                    </label>
                `;
                checkboxContainer.appendChild(item);
            });
            modal.style.display = 'flex';
        });

        const closeModal = () => {
            modal.style.display = 'none';
        };

        closeBtn.addEventListener('click', closeModal);
        cancelBtn.addEventListener('click', closeModal);
        window.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });

        saveBtn.addEventListener('click', () => {
            const newVisibleColumns = [];
            checkboxContainer.querySelectorAll('input[type="checkbox"]:checked').forEach(checkbox => {
                newVisibleColumns.push(checkbox.value);
            });
            gridVisibleColumns = newVisibleColumns;
            renderGridView();
            closeModal();
        });
    }
    // --- SAVE/LOAD FUNCTIONALITY ---
    document.getElementById('save-schedule-btn').addEventListener('click', saveSchedule);
    document.getElementById('load-schedule-btn').addEventListener('click', loadSchedule);
    
    // Add event listener for the unlink toggle
    function setupUnlinkToggleListener() {
    const unlinkToggle = document.getElementById('unlink-on-manual-move');
    if (unlinkToggle) {
        unlinkToggle.addEventListener('change', handleLinkUnlinkToggleChange);
    }
    }
    
    function updateBudgetFromSchedule() {
        if (!budgetData || Object.keys(budgetData).length === 0) return;

        const personnelWeeks = {};
        const diffBusinessDays = (d1, d2) => {
            if (!d1 || !d2 || isNaN(d1.getTime()) || isNaN(d2.getTime()) || d1 > d2) return 0;
            let count = 0;
            const curDate = new Date(d1.getTime());
            while (curDate <= d2) {
                if (isBusinessDay(curDate, 'EDIT')) {
                    count++;
                }
                curDate.setUTCDate(curDate.getUTCDate() + 1);
            }
            return count;
        };

        const globalTotalShootDays = parseInt(document.getElementById('total-shoot-days-display').textContent) || 0;
        const globalShootWeeks = globalTotalShootDays > 0 ? Math.ceil(globalTotalShootDays / 5) : 0;
        const shootingBlocks = getShootingBlocks();
        const wrapOfPhotography = shootingBlocks.length > 0 ? shootingBlocks[shootingBlocks.length - 1].endDate : null;
        const finalDeliveryTasks = masterTaskList.filter(t => t.info.name === "Final Delivery" && t.isScheduled);
        const lastFinalDeliveryDate = finalDeliveryTasks.length > 0 ? new Date(Math.max(...finalDeliveryTasks.map(t => t.scheduledEndDate.getTime()))) : null;
        let globalPostWeeks = 0;
        if (wrapOfPhotography && lastFinalDeliveryDate) {
            const postProductionDays = diffBusinessDays(wrapOfPhotography, lastFinalDeliveryDate);
            globalPostWeeks = Math.ceil(postProductionDays / 5);
        }

        const startOfPhotographyValue = document.getElementById('start-of-photography').value;
        if (!startOfPhotographyValue) return;
        const startOfPhotography = new Date(startOfPhotographyValue + 'T12:00:00Z');

        const lastFinalMixFixesTasks = masterTaskList.filter(t => t.info.name === "Final Mix Fix" && t.isScheduled);
        const lastFinalMixFixesDate = lastFinalMixFixesTasks.length > 0 ? new Date(Math.max(...lastFinalMixFixesTasks.map(t => t.scheduledEndDate.getTime()))) : null;

        const lastMandEDeliveryTasks = masterTaskList.filter(t => t.info.name === "M&E Delivery" && t.isScheduled);
        const lastMandEDeliveryDate = lastMandEDeliveryTasks.length > 0 ? new Date(Math.max(...lastMandEDeliveryTasks.map(t => t.scheduledEndDate.getTime()))) : null;

        const lastVFXDueTasks = masterTaskList.filter(t => t.info.name === "VFX Due" && t.isScheduled);
        const lastVFXDueDate = lastVFXDueTasks.length > 0 ? new Date(Math.max(...lastVFXDueTasks.map(t => t.scheduledEndDate.getTime()))) : null;

        const midpointOfShootDate = addBusinessDays(startOfPhotography, Math.floor(globalTotalShootDays / 2), 'SHOOT');
        const threeWeeksAfterWrapDate = wrapOfPhotography ? addBusinessDays(wrapOfPhotography, 15, 'EDIT') : null;

        const personnelCats = ["Post-Production Staff", "Editorial", "VFX"];
        personnelCats.forEach(category => {
            if (budgetData[category]) {
                budgetData[category].forEach(item => {
                    let shoot = 0;
                    let post = 0;

                    if (item.desc === 'VFX Wrangler') {
                        shoot = globalShootWeeks;
                        post = 0;
                    } else if (item.desc === 'VFX Supervisor' || item.desc === 'VFX Producer' || item.desc === 'VFX Coordinator') {
                        shoot = globalShootWeeks;
                        if (wrapOfPhotography && lastFinalMixFixesDate) {
                             post = Math.ceil(diffBusinessDays(wrapOfPhotography, lastFinalMixFixesDate) / 5);
                        }
                    } else if (item.desc === 'VFX PA') {
                        shoot = globalShootWeeks;
                        if (wrapOfPhotography && lastVFXDueDate) {
                            post = Math.ceil(diffBusinessDays(wrapOfPhotography, lastVFXDueDate) / 5);
                        }
                    } else if (item.desc === 'Post PA') {
                        shoot = globalShootWeeks;
                        if (wrapOfPhotography && lastFinalMixFixesDate) {
                            post = Math.ceil(diffBusinessDays(wrapOfPhotography, lastFinalMixFixesDate) / 5);
                        }
                    } else if (item.desc === 'MX Editor') {
                         if (scheduleType === 'hour-long') {
                            if (midpointOfShootDate && lastMandEDeliveryDate) {
                                const totalDays = diffBusinessDays(midpointOfShootDate, lastMandEDeliveryDate);
                                const shootDays = wrapOfPhotography && midpointOfShootDate < wrapOfPhotography ? diffBusinessDays(midpointOfShootDate, wrapOfPhotography) : 0;
                                shoot = Math.ceil(shootDays / 5);
                                post = Math.ceil((totalDays - shootDays) / 5);
                            }
                         } else {
                            shoot = 0;
                            if (wrapOfPhotography && lastMandEDeliveryDate) {
                                post = Math.ceil(diffBusinessDays(wrapOfPhotography, lastMandEDeliveryDate) / 5);
                            }
                         }
                    } else if (item.desc === 'VFX Editor') {
                         let startDate;
                         if (scheduleType === 'hour-long') {
                            startDate = midpointOfShootDate;
                         } else {
                            startDate = threeWeeksAfterWrapDate;
                         }
                         if (startDate && lastVFXDueDate) {
                             const totalDays = diffBusinessDays(startDate, lastVFXDueDate);
                             const shootDays = wrapOfPhotography && startDate < wrapOfPhotography ? diffBusinessDays(startDate, wrapOfPhotography) : 0;
                             shoot = Math.ceil(shootDays / 5);
                             post = Math.ceil((totalDays - shootDays) / 5);
                         }
                    } else if (item.desc.match(/^(?:Editor|Assistant Editor)/)) {
                        const editorMatch = item.desc.match(/^(?:Editor|Assistant Editor) (\d+)$/);
                        if (editorMatch && masterTaskList.length > 0 && wrapOfPhotography) {
                            const editorIndex = parseInt(editorMatch[1], 10) - 1;
                            const editorEpsSelect = document.getElementById(`editor-eps-${editorIndex}`);
                            if (editorEpsSelect) {
                                const assignedEpIds = Array.from(editorEpsSelect.selectedOptions).map(opt => parseInt(opt.value));
                                if (assignedEpIds.length > 0) {
                                    const editorBlocks = shootingBlocks.filter(block => block.episodes.some(epId => assignedEpIds.includes(epId)));
                                    if (editorBlocks.length > 0) {
                                        const editorFirstShootDay = new Date(Math.min(...editorBlocks.map(b => b.startDate.getTime())));
                                        const dayBeforeEditorStarts = new Date(editorFirstShootDay.getTime());
                                        dayBeforeEditorStarts.setUTCDate(dayBeforeEditorStarts.getUTCDate() - 1);
                                        const unworkedShootDays = diffBusinessDays(startOfPhotography, dayBeforeEditorStarts);
                                        const unworkedShootWeeks = unworkedShootDays / 5;
                                        shoot = globalShootWeeks - unworkedShootWeeks;
                                    } else {
                                        shoot = 0;
                                    }
                                    if (item.desc === 'Assistant Editor 1') {
                                        post = globalPostWeeks;
                                    } else {
                                        const editorPictureLockTasks = masterTaskList.filter(t => assignedEpIds.includes(t.epId) && t.info.name === "Picture Lock" && t.isScheduled);
                                        if (editorPictureLockTasks.length > 0) {
                                            const lastLockDate = new Date(Math.max(...editorPictureLockTasks.map(t => t.scheduledEndDate.getTime())));
                                            const editorPostDays = diffBusinessDays(wrapOfPhotography, lastLockDate);
                                            post = Math.ceil(editorPostDays / 5);
                                        } else {
                                            post = 0;
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        shoot = globalShootWeeks;
                        post = globalPostWeeks;
                    }
                    personnelWeeks[item.desc] = { shoot, post, prep: item.prep, wrap: item.wrap };
                });
            }
        });

        const mxEditorData = personnelWeeks['MX Editor'];
        if (mxEditorData) {
            const totalEditorWeeks = mxEditorData.prep + mxEditorData.shoot + mxEditorData.post + mxEditorData.wrap;
            if (budgetData['Equipment Rentals']) {
                const mxRental = budgetData['Equipment Rentals'].find(item => item.desc === 'MX Editor Kit Rental');
                if (mxRental) {
                    personnelWeeks[mxRental.desc] = { prep: 0, shoot: 0, post: totalEditorWeeks, wrap: 0 };
                }
            }
            if (budgetData['Rooms']) {
                const mxRoomRental = budgetData['Rooms'].find(item => item.desc === 'MX Editor Room');
                if (mxRoomRental) {
                    personnelWeeks[mxRoomRental.desc] = { prep: 0, shoot: 0, post: totalEditorWeeks, wrap: 0 };
                }
            }
        }

        for (const category in budgetData) {
            budgetData[category].forEach(item => {
                const personData = personnelWeeks[item.desc];
                if (personData) {
                    item.shoot = personData.shoot;
                    item.post = personData.post;
                    item.prep = personData.prep;
                    item.wrap = personData.wrap;
                } else {
                    const roomMatch = item.desc.match(/\(([^)]+)\)|(Editor Bay \d+|Assistant Editor Bay \d+)/);
                    let personKey = null;
                    if(roomMatch) {
                        personKey = roomMatch[1] || roomMatch[2].replace(' Bay', '');
                    }

                    if (personKey && personnelWeeks[personKey]) {
                        item.shoot = personnelWeeks[personKey].shoot;
                        item.post = personnelWeeks[personKey].post;
                    } else {
                       const genericRoleMatch = item.desc.match(/^(Post Producer|Post Supervisor)/);
                       if(genericRoleMatch && personnelWeeks[genericRoleMatch[0]]){
                            item.shoot = personnelWeeks[genericRoleMatch[0]].shoot;
                            item.post = personnelWeeks[genericRoleMatch[0]].post;
                       }
                    }
                }
            });
        }
    }
    function setupBudgetEventDelegation() {
        const container = document.getElementById('budget-view');
        if (!container) return;
        
        // Use event delegation - attach once to the container
        container.addEventListener('input', (e) => {
            if (e.target.classList.contains('budget-input')) {
                const parts = e.target.id.split('-');
                const field = parts[1];
                const id = parts[2];
                
                // Find and update the item
                for (let category in budgetData) {
                    const item = budgetData[category].find(item => item.id === id);
                    if (item) {
                        if (e.target.type === 'number') {
                            item[field] = parseFloat(e.target.value) || 0;
                        } else {
                            item[field] = e.target.value;
                        }
                        
                        // Handle syncing for labor items
                        if (category === 'Labor' && ['prep', 'shoot', 'post', 'wrap', 'num'].includes(field)) {
                            syncLaborWeeksToRelatedItems(id);
                        }
                        
                        calculateBudgetTotals();
                        break;
                    }
                }
            }
        });
    }

    function updateBudgetForEditorCount() {
        if (!budgetData || !budgetData.Editorial) return;

        const newEditorCount = parseInt(document.getElementById('num-editors').value) || 0;
        const currentEditorCount = budgetData.Editorial.filter(item => item.desc.startsWith('Editor ')).length;

        if (newEditorCount === currentEditorCount) {
            return;
        }

        if (newEditorCount > currentEditorCount) {
            for (let i = currentEditorCount + 1; i <= newEditorCount; i++) {
                const newEditor = { id: generateUUID(), desc: `Editor ${i}`, num: 1, prep: 0, shoot: 0, post: 20, wrap: 1, rate: 5500, fringeType: 'percent', fringeRate: 40 };
                const newAsstEditor = { id: generateUUID(), desc: `Assistant Editor ${i}`, num: 1, prep: 2, shoot: 0, post: 22, wrap: 2, rate: 3200, fringeType: 'percent', fringeRate: 40 };

                budgetData.Editorial.push(newEditor, newAsstEditor);
                budgetData.Rooms.push({ id: generateUUID(), desc: `Editor Bay ${i}`, num: 1, prep: 0, shoot: 0, post: 22, wrap: 2, rate: 600, fringeType: 'flat', fringeRate: 0 });
                budgetData.Rooms.push({ id: generateUUID(), desc: `Assistant Editor Bay ${i}`, num: 1, prep: 2, shoot: 0, post: 22, wrap: 2, rate: 600, fringeType: 'flat', fringeRate: 0 });
                budgetData['Equipment Rentals'].push({ id: generateUUID(), desc: `AVID Rental (Editor ${i})`, num: 1, prep: 0, shoot: 0, post: 22, wrap: 2, rate: 650, fringeType: 'flat', fringeRate: 0 });
                budgetData['Equipment Rentals'].push({ id: generateUUID(), desc: `AVID Rental (Assistant Editor ${i})`, num: 1, prep: 2, shoot: 0, post: 22, wrap: 2, rate: 650, fringeType: 'flat', fringeRate: 0 });
                budgetData['Box Rentals'].push({ id: generateUUID(), desc: `Box Rental (Editor ${i})`, num: newEditor.num, prep: newEditor.prep, shoot: newEditor.shoot, post: newEditor.post, wrap: newEditor.wrap, rate: 50, fringeType: 'capped', fringeRate: 500 });
                budgetData['Box Rentals'].push({ id: generateUUID(), desc: `Box Rental (Assistant Editor ${i})`, num: newAsstEditor.num, prep: newAsstEditor.prep, shoot: newAsstEditor.shoot, post: newAsstEditor.post, wrap: newAsstEditor.wrap, rate: 50, fringeType: 'capped', fringeRate: 500 });
            }
        }

        if (newEditorCount < currentEditorCount) {
            for (let i = currentEditorCount; i > newEditorCount; i--) {
                const editorDesc = `Editor ${i}`;
                const asstEditorDesc = `Assistant Editor ${i}`;
                const editorBayDesc = `Editor Bay ${i}`;
                const asstEditorBayDesc = `Assistant Editor Bay ${i}`;
                const editorAvidDesc = `AVID Rental (Editor ${i})`;
                const asstEditorAvidDesc = `AVID Rental (Assistant Editor ${i})`;
                const editorBoxDesc = `Box Rental (Editor ${i})`;
                const asstEditorBoxDesc = `Box Rental (Assistant Editor ${i})`;

                budgetData.Editorial = budgetData.Editorial.filter(item => item.desc !== editorDesc && item.desc !== asstEditorDesc);
                budgetData.Rooms = budgetData.Rooms.filter(item => item.desc !== editorBayDesc && item.desc !== asstEditorBayDesc);
                budgetData['Equipment Rentals'] = budgetData['Equipment Rentals'].filter(item => item.desc !== editorAvidDesc && item.desc !== asstEditorAvidDesc);
                budgetData['Box Rentals'] = budgetData['Box Rentals'].filter(item => item.desc !== editorBoxDesc && item.desc !== asstEditorBoxDesc);
            }
        }
    }

    function renderBudgetView() {
        const container = document.getElementById('budget-view');
        if (!container) return;
        
        container.innerHTML = '';

        for (const category in budgetData) {
            const table = document.createElement('table');
            table.className = 'budget-category-table';

            let headerHTML, subtotalColspan;
            if (category === "Rooms" || category === "Equipment Rentals") {
                headerHTML = `<tr><th style="width: 35%;">Description</th><th style="width: 8%;">Num</th><th style="width: 8%;">Prep</th><th style="width: 8%;">Shoot</th><th style="width: 8%;">Post</th><th style="width: 8%;">Wrap</th><th style="width: 10%;">Total Wks</th><th style="width: 10%;">Rate</th><th style="width: 12%;">Total</th><th style="width: 3%;"></th></tr>`;
                subtotalColspan = 8;
            } else if (category === "Box Rentals") {
                headerHTML = `<tr><th style="width: 25%;">Description</th><th style="width: 5%;">Num</th><th style="width: 5%;">Prep</th><th style="width: 5%;">Shoot</th><th style="width: 5%;">Post</th><th style="width: 5%;">Wrap</th><th style="width: 8%;">Total Wks</th><th style="width: 8%;">Rate</th><th style="width: 15%;">Capped?</th><th style="width: 11%;">Total</th><th style="width: 3%;"></th></tr>`;
                subtotalColspan = 9;
            } else {
                headerHTML = `<tr><th style="width: 20%;">Description</th><th style="width: 5%;">Num</th><th style="width: 5%;">Prep</th><th style="width: 5%;">Shoot</th><th style="width: 5%;">Post</th><th style="width: 5%;">Wrap</th><th style="width: 7%;">Total Wks</th><th style="width: 8%;">Rate</th><th style="width: 15%;">Fringes</th><th style="width: 8%;">Labor Total</th><th style="width: 8%;">Fringe Total</th><th style="width: 9%;">Total</th><th style="width: 3%;"></th></tr>`;
                subtotalColspan = 11;
            }

            let tableHTML = `<thead><tr><th colspan="${subtotalColspan + 2}"><h2>${category}</h2></th></tr>${headerHTML}</thead><tbody>`;

            budgetData[category].forEach(item => {
                tableHTML += `<tr data-id="${item.id}">
                    <td><input type="text" id="budget-desc-${item.id}" value="${item.desc}" class="budget-input"></td>
                    <td><input type="number" id="budget-num-${item.id}" value="${item.num}" class="budget-input"></td>
                    <td><input type="number" id="budget-prep-${item.id}" value="${item.prep}" class="budget-input"></td>
                    <td><input type="number" id="budget-shoot-${item.id}" value="${item.shoot.toFixed(2)}" class="budget-input"></td>
                    <td><input type="number" id="budget-post-${item.id}" value="${item.post.toFixed(2)}" class="budget-input"></td>
                    <td><input type="number" id="budget-wrap-${item.id}" value="${item.wrap}" class="budget-input"></td>
                    <td id="budget-total-weeks-${item.id}"></td>
                    <td><input type="number" id="budget-rate-${item.id}" value="${item.rate}" class="budget-input"></td>`;

                if (category === "Rooms" || category === "Equipment Rentals") {
                     tableHTML += `<td id="budget-line-total-${item.id}"></td>`;
                } else if (category === "Box Rentals") {
                    tableHTML += `<td>
                            <div class="fringe-group">
                                <select id="budget-fringeType-${item.id}" class="budget-input">
                                    <option value="capped" ${item.fringeType === 'capped' ? 'selected' : ''}>Yes</option>
                                    <option value="none" ${item.fringeType !== 'capped' ? 'selected' : ''}>No</option>
                                </select>
                                <input type="number" id="budget-fringeRate-${item.id}" value="${item.fringeRate}" class="budget-input">
                            </div>
                        </td><td id="budget-line-total-${item.id}"></td>`;
                } else {
                    tableHTML += `<td>
                            <div class="fringe-group">
                                <select id="budget-fringeType-${item.id}" class="budget-input">
                                    <option value="percent" ${item.fringeType === 'percent' ? 'selected' : ''}>%</option>
                                    <option value="flat" ${item.fringeType === 'flat' ? 'selected' : ''}>$</option>
                                </select>
                                <input type="number" id="budget-fringeRate-${item.id}" value="${item.fringeRate}" class="budget-input">
                            </div>
                        </td>
                        <td id="budget-labor-total-${item.id}"></td>
                        <td id="budget-fringe-total-${item.id}"></td>
                        <td id="budget-line-total-${item.id}"></td>`;
                }
                tableHTML += `<td><button class="delete-button delete-line-item-btn" data-id="${item.id}">&times;</button></td></tr>`;
            });

            tableHTML += `</tbody><tfoot><tr>
                    <td colspan="${subtotalColspan}" class="subtotal">Subtotal</td>
                    <td id="subtotal-${category.replace(/\s+/g, '-')}" class="subtotal"></td>
                    <td></td>
                </tr></tfoot>`;
            table.innerHTML = tableHTML;
            container.appendChild(table);
            const addBtn = document.createElement('button');
            addBtn.textContent = `+ Add Line Item to ${category}`;
            addBtn.className = 'primary-action add-line-item-btn';
            addBtn.dataset.category = category;
            container.appendChild(addBtn);
        }
        const grandTotalEl = document.createElement('div');
        grandTotalEl.innerHTML = `<h2>Grand Total: <span id="grand-total" class="grand-total">$0.00</span></h2>`;
        container.appendChild(grandTotalEl);

        addBudgetEventListeners();
        calculateBudgetTotals();
    }

    function calculateBudgetTotals() {
        let grandTotal = 0;
        const currencyFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

        document.querySelectorAll('.budget-category-table').forEach(table => {
            let categorySubtotal = 0;
            const categoryName = table.querySelector('h2').textContent;
            const categoryKey = categoryName.replace(/\s+/g, '-');

            table.querySelectorAll('tbody tr').forEach(row => {
                const id = row.dataset.id;
                if (!id) return;

                const num = parseFloat(document.getElementById(`budget-num-${id}`).value) || 0;
                const prep = parseFloat(document.getElementById(`budget-prep-${id}`).value) || 0;
                const shoot = parseFloat(document.getElementById(`budget-shoot-${id}`).value) || 0;
                const post = parseFloat(document.getElementById(`budget-post-${id}`).value) || 0;
                const wrap = parseFloat(document.getElementById(`budget-wrap-${id}`).value) || 0;
                const rate = parseFloat(document.getElementById(`budget-rate-${id}`).value) || 0;

                const totalWeeks = prep + shoot + post + wrap;
                const laborTotal = num * totalWeeks * rate;
                let fringeTotal = 0;
                let lineTotal = 0;

                if(categoryName === "Rooms" || categoryName === "Equipment Rentals") {
                    lineTotal = laborTotal;
                } else {
                    const fringeType = document.getElementById(`budget-fringeType-${id}`).value;
                    const fringeRate = parseFloat(document.getElementById(`budget-fringeRate-${id}`).value) || 0;
                    if (fringeType === 'percent') {
                        fringeTotal = laborTotal * (fringeRate / 100);
                    } else if (fringeType === 'flat') {
                        fringeTotal = num * totalWeeks * fringeRate;
                    } else if (fringeType === 'capped') {
                        const cap = fringeRate;
                        fringeTotal = Math.min(laborTotal, cap * num);
                    }
                    lineTotal = laborTotal + fringeTotal;

                    if(categoryName === "Box Rentals") {
                         lineTotal = fringeType === 'capped' ? fringeTotal : laborTotal;
                    }
                    const laborTotalEl = document.getElementById(`budget-labor-total-${id}`);
                    const fringeTotalEl = document.getElementById(`budget-fringe-total-${id}`);
                    if(laborTotalEl) laborTotalEl.textContent = currencyFormat.format(laborTotal);
                    if(fringeTotalEl) fringeTotalEl.textContent = currencyFormat.format(fringeTotal);
                }

                document.getElementById(`budget-total-weeks-${id}`).textContent = totalWeeks.toFixed(2);
                document.getElementById(`budget-line-total-${id}`).textContent = currencyFormat.format(lineTotal);

                categorySubtotal += lineTotal;
            });

            document.getElementById(`subtotal-${categoryKey}`).textContent = currencyFormat.format(categorySubtotal);
            grandTotal += categorySubtotal;
        });

        document.getElementById('grand-total').textContent = currencyFormat.format(grandTotal);
    }

    function findBudgetItemById(id) {
        for (let category in budgetData) {
            const item = budgetData[category].find(item => item.id === id);
            if (item) {
                item.category = category; // Add category for reference
                return item;
            }
        }
        return null;
    }

    function addBudgetEventListeners() {
        document.querySelectorAll('.budget-input').forEach(input => {
            input.addEventListener('input', (e) => {
                const id = e.target.id.split('-')[2];
                const field = e.target.id.split('-')[1];
                const item = findBudgetItemById(id);
                
                if (item) {
                    item[field] = e.target.type === 'number' ? 
                        parseFloat(e.target.value) || 0 : e.target.value;
                    
                    // If this is a Labor item and weeks changed, sync to related items
                    if (item.category === 'Labor' && 
                        ['prep', 'shoot', 'post', 'wrap'].includes(field)) {
                        syncLaborWeeksToRelatedItems(id);
                    }
                }
                
                calculateBudgetTotals();
            });
        });

        // Inside addBudgetEventListeners function, replace the add-line-item-btn handler with:
document.querySelectorAll('.add-line-item-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const category = e.target.dataset.category;
        
        if (category === 'Labor') {
            // Use the modal for labor items
            showAddLaborModal();
        } else {
            // Regular inline add for other categories
            const newItem = {
                id: generateUUID(),
                desc: 'New Item',
                num: 1,
                prep: 0,
                shoot: 0,
                post: 0,
                wrap: 0,
                rate: 0
            };
            
            // Add category-specific fields
            if (category === 'Box Rentals') {
                newItem.fringeType = 'none';
                newItem.fringeRate = 0;
            } else if (category === 'Fabrication') {
                newItem.fringeType = 'percent';
                newItem.fringeRate = 25;
            }
            
            budgetData[category].push(newItem);
            renderBudgetView();
        }
    });
});    
                
         document.querySelectorAll('.delete-line-item-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.target.dataset.id;
                const category = e.target.closest('.budget-category-table').querySelector('h2').textContent;
                budgetData[category] = budgetData[category].filter(item => item.id !== id);
                renderBudgetView();
            });
        });
    }
    function autoGenerateCrewRelatedItems(laborItem) {
        const crewName = laborItem.desc;
        const laborId = laborItem.id;
        
        // Check if related items already exist
        const roomExists = budgetData['Rooms'].some(item => 
            item.desc.toLowerCase() === `${crewName.toLowerCase()} room` ||
            item.laborRef === laborId
        );
        
        if (!roomExists) {
            // Add Room
            budgetData['Rooms'].push({
                id: generateUUID(),
                desc: `${crewName} Room`,
                num: laborItem.num || 1,
                prep: 0,  // Will be linked to labor
                shoot: 0, // Will be linked to labor
                post: 0,  // Will be linked to labor
                wrap: 0,  // Will be linked to labor
                rate: 0,  // User can fill in later
                laborRef: laborId  // Link to labor item
            });
            
            // Add Equipment
            budgetData['Equipment Rentals'].push({
                id: generateUUID(),
                desc: `${crewName} Equipment`,
                num: laborItem.num || 1,
                prep: 0,
                shoot: 0,
                post: 0,
                wrap: 0,
                rate: 0,
                laborRef: laborId
            });
            
            // Add Box Rental
            budgetData['Box Rentals'].push({
                id: generateUUID(),
                desc: `${crewName} Box Rental`,
                num: laborItem.num || 1,
                prep: 0,
                shoot: 0,
                post: 0,
                wrap: 0,
                rate: 0,
                fringeType: 'none',
                fringeRate: 0,
                laborRef: laborId
            });
        }
    }
    
    // Function to sync weeks from labor to related items
    function syncLaborWeeksToRelatedItems(laborId) {
        const laborItem = budgetData['Labor'].find(item => item.id === laborId);
        if (!laborItem) return;
        
        // Update Rooms
        budgetData['Rooms'].forEach(item => {
            if (item.laborRef === laborId) {
                item.prep = laborItem.prep;
                item.shoot = laborItem.shoot;
                item.post = laborItem.post;
                item.wrap = laborItem.wrap;
            }
        });
        
        // Update Equipment Rentals
        budgetData['Equipment Rentals'].forEach(item => {
            if (item.laborRef === laborId) {
                item.prep = laborItem.prep;
                item.shoot = laborItem.shoot;
                item.post = laborItem.post;
                item.wrap = laborItem.wrap;
            }
        });
        
        // Update Box Rentals
        budgetData['Box Rentals'].forEach(item => {
            if (item.laborRef === laborId) {
                item.prep = laborItem.prep;
                item.shoot = laborItem.shoot;
                item.post = laborItem.post;
                item.wrap = laborItem.wrap;
            }
        });
    }

    function initializeApp() {
        setupCollapsibleSections();
        generateHolidaySelectors();
        setupTabControls();
        setupModal();
        setupHiatusModal();
        setupSixthDayModal();
        setupColumnConfigModal();
        loadDefaults('hour-long');
        document.getElementById('app-Dr_g0n-container').innerHTML = AppDr_g0n;
        
        setupAllEventListeners();
        setupEnhancedInputListeners();
        setupUnlinkToggleListener(); // ADD THIS LINE
        setupBudgetEventDelegation();
        
        // Explicit handlers for the problematic checkboxes
        document.getElementById('producers-cuts-overlap').addEventListener('change', (e) => {
            setLastChangedInput(e.target.id);
            handleInputChange(e.target);
        });
        
        document.getElementById('producers-cuts-pre-wrap').addEventListener('change', (e) => {
            setLastChangedInput(e.target.id);
            handleInputChange(e.target);
        });
        
        document.getElementById('toggle-sequential-lock').addEventListener('change', (e) => {
            setLastChangedInput(e.target.id);
            handleInputChange(e.target);
        });
    }

    initializeApp();
    console.log("Script loaded successfully");
});