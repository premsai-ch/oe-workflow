/**
 *
 * ©2016-2017 EdgeVerve Systems Limited (a fully owned Infosys subsidiary),
 * Bangalore, India. All Rights Reserved.
 *
 */
/**
 * @description  Implementation of Process-Instance
 * @author Kangan Verma(kangan06), Mandeep Gill(mandeep6ill), Nirmal Satyendra(iambns), Prem Sai(premsai-ch), Vivek Mittal(vivekmittal07)
 */

var TOKEN_ARRIVED_EVENT = 'TOKEN_ARRIVED_EVENT';
var SUBPROCESS_END_EVENT = 'SUBPROCESS_END_EVENT';
var INTERMEDIATE_CATCH_EVENT = 'INTERMEDIATE_CATCH_EVENT';
var SUBPROCESS_INTERRUPT_EVENT = 'SUBPROCESS_INTERRUPT_EVENT';
var TERMINATE_INTERRUPT_EVENT = 'TERMINATE_INTERRUPT_EVENT';
var PROCESS_TERMINATE = 'PROCESS_TERMINATE';

var logger = require('oe-logger');
var log = logger('ProcessInstance');

var _ = require('lodash');

var timerEvents = require('./lib/timeouts');
var processTokens = require('./process-tokens.js');
var StateDelta = require('./process-state-delta.js');
var sandbox = require('./lib/workflow-nodes/sandbox.js');

var subprocessEventHandler = require('./lib/workflow-eventHandlers/subprocesshandlers.js');
var catchEventHandler = require('./lib/workflow-eventHandlers/catcheventhandler.js');
var tokenEventHandler = require('./lib/workflow-eventHandlers/tokeneventhandler.js');

var TokenEmission = require('./lib/tokenemission');
var throwObject = require('./lib/throwobject.js');

/**
 * @param  {Object} ProcessInstance Process-Instance
 */
module.exports = function ProcessInstance(ProcessInstance) {
  ProcessInstance.on(TOKEN_ARRIVED_EVENT, tokenEventHandler._tokenArrivedEventHandler);
  ProcessInstance.on(SUBPROCESS_END_EVENT, subprocessEventHandler._subProcessEndEventHandler);
  ProcessInstance.on(INTERMEDIATE_CATCH_EVENT, catchEventHandler._intermediateCatchEventHandler);
  ProcessInstance.on(SUBPROCESS_INTERRUPT_EVENT, subprocessEventHandler._subProcessInterruptHandler);
  ProcessInstance.on(PROCESS_TERMINATE, subprocessEventHandler._subProcessInterruptHandler);
  ProcessInstance.on(TERMINATE_INTERRUPT_EVENT, subprocessEventHandler._terminateInterruptHandler);

    /**
     * Before Save Observer Hook
     */
  ProcessInstance.observe('before save', function beforeSavePI(ctx, next) {
    if (ctx.isNewInstance) {
      var instance = ctx.instance;
      instance.processDefinition({}, ctx.options, function fetchPD(err, processDefinitionInstance) {
        if (err) {
          log.error(ctx.options, err.message);
          return next(err);
        }
        // console.log('Process-Definition isntance is : ',JSON.stringify(processDefinitionInstance,null,'\t'),JSON.stringify(err,null,'\t'));
        if (!processDefinitionInstance) {
          return next(new Error('Process definition not present'));
        }
        var startFlowObject = processDefinitionInstance.getStartEvent();

        if (!ctx.options) {
          var ctxerr = new Error('Workflow context init failed.');
          log.error(log.defaultContext(), ctxerr);
          return next(ctxerr);
        }
        var options = ctx.options;
        instance.init(options);

        var token = processTokens.createToken(startFlowObject.name, startFlowObject.bpmnId, instance.message);
        instance._processTokens[token.id] = token;

        instance.processDefinitionBpmnId = processDefinitionInstance.processDefinition.bpmnId;
        instance.unsetAttribute('message');
        instance.unsetAttribute('processVariables');
        next(err);
      });
    } else {
      next();
    }
  });

    /**
     * After Save Observer Hook
     */
  ProcessInstance.observe('after save', function afterSavePD(ctx, next) {
    if (ctx.isNewInstance) {
      var instance = ctx.instance;
      var options = instance._workflowCtx;

      var tokenIds = Object.keys(instance._processTokens);
      if (tokenIds.length === 1) {
        ProcessInstance.emit(TOKEN_ARRIVED_EVENT, options, ProcessInstance, instance, instance._processTokens[tokenIds[0]]);
      } else  {
        // multiple start events found, or no start event found
        var err = new Error('multiple start events found, or no start event found');
        log.error(ctx.options, err);
        return next(err);
      }
      next();
    } else {
      next();
    }
  });

    /**
     * Initialize the embedded properties
     * @param {Object} options Workflow Context
     * @returns {void}
     */
  ProcessInstance.prototype.init = function init(options) {
    this._processTokens = {};
    if (this.processVariables && typeof (this.processVariables) !== 'object') {
      var parseError = new Error('Process variables should be in Json format');
      log.error(options, parseError);
      return parseError;
    }

    this._processVariables = this.processVariables || {};
    this._status = 'running';
    this._processTimerEvents = {
      pendingTimeouts: {},
      endedTimeouts: {},
      timeoutIds: {},
      timerIds: {}
    };
    this._synchronizeFlow = {};
    this._workflowCtx = JSON.parse(JSON.stringify(options));
  };

    /**
     * Interaction point for RecieveMessage
     * @param  {Object}   options Options
     * @param  {String}   bpmnId  Bpmn Id
     * @param  {Object}   message Message
     * @param  {Function} next    Callback
     */
  ProcessInstance.prototype._recieveMessage = function _recieveMessage(options, bpmnId, message, next) {
    next = next || function empty() {};
    var self = this;
    this.processDefinition({}, options, function fetchPD(err, processDefinitionInstance) {
      if (err) {
        return next(err);
      }
      var taskObj = processDefinitionInstance.getProcessElement(bpmnId);
      if (taskObj === null) {
        return next(new Error('No corresponding taskName found.'));
      }
      var tokens = self._processTokens;
      var token = null;
      for (var i in tokens) {
        if (tokens[i].name === taskObj.name) {
          token = tokens[i];
        }
      }

      if (token === null) {
        log.debug(options, 'Token not found');
        return next(new Error('No corresponding token found.'));
      } else if (token.status !== 'pending') {
        log.debug(options, 'Task Already completed');
        return next(new Error('Task status is ' + token.status));
      }

      var delta = new StateDelta();
      // to disable boundary timer event if task is completed beforehand
      self._clearBoundaryTimerEvents(delta, options, processDefinitionInstance.getFlowObjectByName(token.name));
      self._endFlowObject(options, token, processDefinitionInstance, delta, message, next);
    });
  };

    /**
     * Handling Completion of User
     * @param  {Object}   options          Options
     * @param  {Object}   task             Task
     * @param  {Object}   message          Message
     * @param  {Object}   processVariables ProcessVariables
     * @param  {Function} next             Callback
     * @returns {void}
     */
  ProcessInstance.prototype._completeTask = function _completeTask(options, task, message, processVariables, next) {
    var self = this;
    var token = this._processTokens[task.processTokenId];

    if (token === null) {
      log.debug(options, 'Token not found for the task');
      return next(new Error('Token not found for the task'));
    } else if (token.status !== 'pending') {
      log.debug(options, 'Task already completed');
      return next(new Error('Task already completed'));
    }
    var delta = new StateDelta();
    delta.setProcessVariables(processVariables);

    self.processDefinition({}, options, function fetchPD(err, processDefinitionInstance) {
      if (err) {
        log.error(options, err);
        return next(err);
      }

      // to disable boundary timer event if task is completed beforehand
      self._clearBoundaryTimerEvents(delta, options, processDefinitionInstance.getFlowObjectByName(token.name));
      self._endFlowObject(options, token, processDefinitionInstance, delta, message, next);
    });
  };

    /**
     * All actions to be performed while ending a flowobject has to be done here
     * Remove token from state, update end time , clear boundary timer events
     * Emit further tokens
     * @param  {Object}   options                   Options
     * @param  {Object}   flowObjectToken           Process-Token
     * @param  {Object}   processDefinitionInstance Process-Definition
     * @param  {Object}   delta                     Process-State-Delta
     * @param  {Object}   message                   Message
     * @param  {Function} next                      Callback
     * @returns {void}
     */
  ProcessInstance.prototype._endFlowObject = function _endFlowObject(options, flowObjectToken, processDefinitionInstance, delta, message, next) {
    next = next || function empty() {};

    var currentFlowObjectName = flowObjectToken.name;
    var currentFlowObject = processDefinitionInstance.getFlowObjectByName(currentFlowObjectName);
    var self = this;

    var nextFlowObjects = TokenEmission.getNextFlowObjects(currentFlowObject, message,
                                                            processDefinitionInstance, self, options);
    for (var i in nextFlowObjects) {
      if (Object.prototype.hasOwnProperty.call(nextFlowObjects, i)) {
        var obj = nextFlowObjects[i];
        var meta;

        if (obj.isParallelGateway) {
          meta = {
            type: 'ParallelGateway',
            gwId: obj.bpmnId
          };
        } else if (obj.isAttachedToEventGateway) {
          meta = {
            type: 'EventGateway',
            tokensToInterrupt: obj.attachedFlowObjects
          };
        }

        var token = processTokens.createToken(obj.name, obj.bpmnId, message, meta);

        if (obj.isParallelGateway) {
          delta.setPGSeqsToExpect(obj.bpmnId, obj.expectedInFlows);
          delta.setPGSeqToFinish(obj.bpmnId, obj.attachedSeqFlow, token.id);
        }

        if (obj.isMultiInstanceLoop) {
          try {
            if (obj.hasCollection) {
              var collection = sandbox.evaluateAccessExpression(options, obj.collection, message, self);
              if (typeof collection === 'undefined') {
                throw new Error('collection in multi instance is undefined.');
              }
              if (collection.constructor.name !== 'Array') {
                throw new Error('defined collection in multi instance is not an arary');
              }
              token.nrOfInstances = collection.length;
              token.collection = collection;
              token.elementVariable = obj.elementVariable;
            } else if (obj.hasLoopCardinality) {
              var loopcounter = sandbox.evaluate$Expression(options, obj.loopcounter, message, self);
              token.nrOfInstances = Number(loopcounter);
            } else {
              throw new Error('invalid multi instance specification error');
            }
          } catch (err) {
            log.error(options, err);
            return next(err);
          }

          if (obj.isSequential) {
            token.nrOfActiveInstances = 1;
            token.isSequential = true;
          } else {
            token.nrOfActiveInstances = token.nrOfInstances;
            token.isParallel = true;
          }

          if (obj.hasCompletionCondition) {
            token.hasCompletionCondition = true;
            token.completionCondition = obj.completionCondition;
          }

          token.nrOfCompleteInstances = 0;
        }

        log.debug(options, token);
        if (token === null) {
          log.error(options, 'Invalid token');
          return next(new Error('Invalid token'));
        }
        delta.addToken(token);
      }
    }
    delta.setTokenToRemove(flowObjectToken.id);

    // add boundary event tokens to interrupt for the currentFlowObject that we are completing, if any
    if (processDefinitionInstance.processDefinition.boundaryEventsByAttachmentIndex[flowObjectToken.bpmnId]) {
      var boundaryEvents = processDefinitionInstance.processDefinition.boundaryEventsByAttachmentIndex[flowObjectToken.bpmnId];
      for (i = 0; i < boundaryEvents.length; i++) {
        var boundaryEvent = boundaryEvents[i];
        var boundaryEventToken = self.getTokenByFlowObject(boundaryEvent);
        if (boundaryEventToken && self.isPending(boundaryEventToken)) {
          delta.setTokenToInterrupt(boundaryEventToken.id);
        }
      }
    }

    self.commit(options, delta, function commit(err, instance) {
      if (err) {
        // If there are no changes to apply then we don't have to emit further events.
        log.error(options, err.message);
        return next(err);
      }

      if (instance._status === 'complete') {
        instance.parentProcess({}, options, function fetchParentProcess(err, parentProcess) {
          if (err) {
            log.error(options, err.message);
            return;
          }

          // This is to allow a subprocess to not go to the parent process unless all the subflows have ended
          if (parentProcess) {
            ProcessInstance.emit(SUBPROCESS_END_EVENT, options, parentProcess, instance.parentToken, instance._processVariables);
          }
        });
      }

      /**
       * Once multi instance completes due to all iterations or completion condition we will reach here
       */
      if (currentFlowObject.isMultiInstanceLoop) {
        flowObjectToken = instance._processTokens[flowObjectToken.id];
        if (flowObjectToken.isSequential) {
          if (flowObjectToken.nrOfActiveInstances === 1 && flowObjectToken.status === 'pending') {
            ProcessInstance.emit(TOKEN_ARRIVED_EVENT, options, ProcessInstance, instance, flowObjectToken);
            return next();
          } else if (flowObjectToken.nrOfActiveInstances === 1 && flowObjectToken.status !== 'pending') {
            // nrOfActiveInstances still remaining cause of completion condition
            // no need to interrupt anything cause its sequential
          }
        } else if (flowObjectToken.isParallel) {
          if (flowObjectToken.nrOfCompleteInstances !== flowObjectToken.nrOfInstances && flowObjectToken.status === 'pending') {
            return next();
          } else if (flowObjectToken.nrOfCompleteInstances !== flowObjectToken.nrOfInstances && flowObjectToken.status !== 'pending') {
            // all multi instance have not completed but the token has completed, due to completion condition
            // we need to interrupt tasks/subprocess corresponding to this token which are not complete, before continuing
            if (currentFlowObject.isUserTask) {
              let _options = _.cloneDeep(options);
              _options._skip_tf = true;
              let Task = ProcessInstance.app.models.Task;

              // interrupting after timeout because task completion happens after process state update which will would not have updated to complete by this time
              setTimeout(function interruptTaskAfterSomeTime() {
                Task.find({
                  where: {
                    and: [{
                      processTokenId: flowObjectToken.id
                    }, {
                      status: 'pending'
                    }]
                  }
                }, _options, function fetchTask(err, tasks) {
                  if (err) {
                    return log.error(options, err);
                  }

                  for (let i = 0; i < tasks.length; i++) {
                    let task = tasks[i];
                    Task.emit('TASK_INTERRUPT_EVENT', options, Task, task);
                    log.debug(options, 'Signal sent to Task with id ' + task.id + ' to interrupt [Completion condition MI].');
                  }
                });
              }, 1000);
            } else if (currentFlowObject.isSubProcess || currentFlowObject.isCallActivity) {
              ProcessInstance.find({
                where: {
                  and: [{
                    _status: 'running'
                  }, {
                    parentProcessInstanceId: instance.id
                  }]
                }
              }, options, function fetchUnCompletedSubPrcess(err, instances) {
                if (err) {
                  return log.error(options, err);
                }
                let filteredInstances = instances.filter(function filterOnToken(fInstance) {
                  return fInstance.parentToken && fInstance.parentToken.id === flowObjectToken.id;
                });
                filteredInstances.forEach(function interruptSubProcesses(_subProcess) {
                  ProcessInstance.emit(SUBPROCESS_INTERRUPT_EVENT, options, ProcessInstance, _subProcess);
                });
              });
            }
          }
        }
      }

      for (var i in delta.tokens) {
        if (Object.prototype.hasOwnProperty.call(delta.tokens, i)) {
          var token = delta.tokens[i];
          token = instance._processTokens[token.id];

          /**
          * In case of parallel and sequential new tokens will be created only
          * when all instances end
          **/
          if (!token) {
            break;
          }
          // TODO : why this check token.id !== delta.tokenToRemove
          if (token.isParallel) {
            var loopcount = token.nrOfInstances;
            var counter = 0;
            while (counter < loopcount) {
              token.inVariables = token.inVariables || {};
              if (token.elementVariable) {
                token.inVariables[token.elementVariable] = token.collection[counter];
              }
              token.inVariables._iteration = counter;
              var _token = _.cloneDeep(token);
              ProcessInstance.emit(TOKEN_ARRIVED_EVENT, options, ProcessInstance, instance, _token);
              counter++;
            }
          } else {
            ProcessInstance.emit(TOKEN_ARRIVED_EVENT, options, ProcessInstance, instance, token);
          }
        }
      }
      next();
    });
  };

  ProcessInstance.prototype.recover = function recover() {
    var self = this;
    var tokens = self._processTokens;
    var options = self._workflowCtx;
    Object.keys(tokens).filter(function filterPendingTokens(tokenId) {
      return tokens[tokenId].status === 'pending';
    }).forEach(function continueWorkflow(tokenId) {
      self.reemit(tokens[tokenId], options);
    });
  };

  ProcessInstance.prototype.getSubProcessByToken = function getSubProcessByToken(token, instance, options, next) {
    instance.subProcesses({}, options, function fetchSubProcess(err, subprocesses) {
      if (err) {
        return next(err);
      }
      var subprocess = subprocesses.filter(function filterTokenSubProcess(proc) {
        if (proc.parentToken && proc.parentToken.name === token.name && proc.parentToken.id === token.id) {
          return true;
        }
        return false;
      });
      if (subprocess.length === 0) {
        var error = new Error('No subprocess for the call-activity/sub-process token found.');
        return next(error);
      } else if (subprocess.length > 1) {
        var errorx = new Error('Multiple subprocesses for the call-activity/sub-process token found.');
        return next(errorx);
      }
      next(null, subprocess[0]);
    });
  };

  ProcessInstance.prototype.reemit = function reemit(token, options, next) {
    var instance = this;
    next = next || function dummy() {};

    var currentFlowObjectName = token.name;

    instance.processDefinition(options, function fetchDefn(err, processDefinitionInstance) {
      if (err) {
        log.error(options, err);
        return next(err);
      }
      var currentFlowObject = processDefinitionInstance.getFlowObjectByName(currentFlowObjectName);

      if (currentFlowObject.isMultiInstanceLoop && currentFlowObject.isParallel) {
        for (var i = 0; i < currentFlowObject.nrOfActiveInstances; i++) {
          ProcessInstance.emit(TOKEN_ARRIVED_EVENT, options, ProcessInstance, instance, token);
        }
      } else if (currentFlowObject.isCallActivity || currentFlowObject.isSubProcess) {
        // check if call Activity has created a process, if not only then emit
        instance.getSubProcessByToken(token, instance, options, function fetchSubProcess(err, subprocess) {
          if (err) {
            log.error(options, err);
            return next(err);
          }
          if (subprocess._status === 'complete') {
            // sub process is already complete move the token forward for the parent workflow
            // this condition is very less likely
            ProcessInstance.emit(TOKEN_ARRIVED_EVENT, options, ProcessInstance, instance, token);
          } else {
            // wait, sub process on its own will complete the token
          }
        });
      } else if (currentFlowObject.isTimerEvent && currentFlowObject.timeDuration) {
        var at = token.startTime;
        var now = Date.now();
        // calculating again to handle pending timeout
        var diff = now - at;
        var recoveryPayload = {
          _diff: diff,
          applicableTo: function applicableTo(flowObject) {
            if (currentFlowObject.isTimerEvent && currentFlowObject.timeDuration) {
              return true;
            }
            return false;
          }
        };

        ProcessInstance.emit(TOKEN_ARRIVED_EVENT, options, ProcessInstance, instance, token, null,  recoveryPayload);
      } else if ( currentFlowObject.isUserTask) {
        let xoptions = JSON.parse(JSON.stringify(options));
        xoptions._skip_tf = true;
        instance.tasks({
          'where': {
            'name': currentFlowObject.name
          }
        }, xoptions, function fetchTaskToVerifyIfExists(err, tasks) {
          if (err) {
            log.error(options, err);
            return next(err);
          }
          if (tasks.length === 0) {
            // in case of recovery if user task was not created but token exists then we need to emit token
            ProcessInstance.emit(TOKEN_ARRIVED_EVENT, options, ProcessInstance, instance, token);
          }
        });
      } else {
        ProcessInstance.emit(TOKEN_ARRIVED_EVENT, options, ProcessInstance, instance, token);
      }

      next();
    });
  };

    /**
     * App update calls to the process-instance have to be done using this method
     * This is required to ensure atomic update to the process-instance.
     * Try to apply the delta(change in the state to the process instance) to the latest
     * Throws an error if there are no changes to apply.
     * @param  {Object}   options Options
     * @param  {Object}   delta   Process-State-Delta
     * @param  {Function} next    Callback
     * @returns {void}
     */
  ProcessInstance.prototype.commit = function commit(options, delta, next) {
    var self = this;
    var changes = delta.apply(self, options);

    if (changes ===  null) {
      var err = new Error('trying to make invalid state change');
      // log debug instead of log error cause some other node might have interuppted or completed the process
      log.debug(options, 'trying to make invalid state change');
      return next(err);
    }

    ProcessInstance.upsert(changes, options, function updatePI(err, instance) {
      if (err) {
        log.error(options, err.message);
        setImmediate(retryCommit, options);
      } else {
        next(null, instance);
      }
    });

    function retryCommit(options) {
      ProcessInstance.findById(self.id, options, function fetchPI(err, instance) {
        if (err) {
          log.error(options, err);
          return next(err);
        }
        instance.commit(options, delta, next);
      });
    }
  };

    /**
     * Finding a processToken if the name of the flow Object is given
     * @param  {Object} flowObject FlowObject
     * @return {Object}            Process-Token
     */
  ProcessInstance.prototype.findToken = function findToken(flowObject) {
    var self = this;
    var token = null;
    var name = 'name';
    for (var key in self._processTokens) {
      if (self._processTokens[key][name] === flowObject[name]) {
        token = self._processTokens[key];
      }
    }
    return token;
  };

    /**
     * Finding whether a given flowObject has a token in the process Tokens list
     * @param  {Object} flowObject FlowObject
     * @returns {Boolean} Return true if Process Token is pending
     */
  ProcessInstance.prototype.isPending = function isPending(flowObject) {
    var self   = this;
    var result = false;
    var status = 'status';
    var name   = 'name';

    for (var key in self._processTokens) {
      if (self._processTokens[key][name] === flowObject[name] && self._processTokens[key][status] === 'pending') {
        result = true;
      }
    }

    return result;
  };

    /**
     * register timer events
     * @param  {Object} options          Options
     * @param  {String} type             Type
     * @param  {Object} currentActivity  CurrentActivity
     * @param  {String} tokenId          Token ID
     */
  ProcessInstance.prototype._registerTimerEvents = function _registerTimerEvents(options, type, currentActivity, tokenId) {
    var self = this;
    var delta = new StateDelta();

    if (type === 'START') {
      var startEvent = currentActivity;
      log.debug(options, 'Token was put on \'' + startEvent.name);
      timerEvents.addStartTimerEvent(delta, options, ProcessInstance, self, startEvent, tokenId);
    } else if (type === 'INTERMEDIATE') {
      var intermediateEvent = currentActivity;
      log.debug(options, 'Token was put on \'' + intermediateEvent.name);
      timerEvents.addIntermediateTimerEvent(delta, options, ProcessInstance, self, intermediateEvent, tokenId);
    } else if (type === 'BOUNDARY') {
      var boundaryEvent = currentActivity;
      log.debug(options, 'Token was put on \'' + boundaryEvent.name);
      timerEvents.addBoundaryTimerEvent(delta, options, ProcessInstance, self, boundaryEvent, tokenId);
    } else {
      log.error(options, 'Unknown type of Timer Event being requested.');
    }
  };

  ProcessInstance.prototype.getFlowObjectByToken = function getFlowObjectByToken(token, options, next) {
    var self = this;
    self.processDefinition({}, options, function fetchPD(err, processDefinitionInstance) {
      if (err) {
        log.error(options, err);
        return next(err);
      }
      next(null, processDefinitionInstance.getProcessElement(token.bpmnId));
    });
  };

  ProcessInstance.prototype.getTokenByFlowObject = function getFlowObjectByToken(flowobject) {
    var self = this;
    var processTokens = self._processTokens;
    for (var i in processTokens) {
      if (processTokens[i].bpmnId === flowobject.bpmnId) {
        return processTokens[i];
      }
    }
    return null;
  };


    /**
     * clear boundary timer events
     * @param  {Object} delta               Process-State-Delta
     * @param  {Object} options             Options
     * @param  {Object} currentFlowObject   CurrentFlowObject
     */
  ProcessInstance.prototype._clearBoundaryTimerEvents = function _clearBoundaryTimerEvents(delta, options, currentFlowObject) {
    var self = this;
    self.processDefinition({}, options, function fetchPD(err, processDefinitionInstance) {
      if (err) {
        log.error(options, err);
        return;
      }
      var boundaryEvents = processDefinitionInstance.getBoundaryEventsAt(currentFlowObject);
      boundaryEvents.forEach(function iterateBoundaryEvents(boundaryEvent) {
        if (boundaryEvent.isTimerEvent) {
          timerEvents.removeTimeout(delta, boundaryEvent.name);
        }
      });
    });
  };

    /**
     * catch timer events
     * @param  {Object} delta               Process-State-Delta
     * @param  {Object} options             Options
     * @param  {Object} processInstance     Process-Instance
     * @param  {Object} token               Process-Token
     * @param  {String} source              Source
     */
  ProcessInstance.prototype._catchTimerEvents = function _catchTimerEvents(delta, options, processInstance, token, source) {
    if (source !== 'undo') {
      var payLoad = throwObject.throwObject('timer', token.name);
      ProcessInstance.emit(INTERMEDIATE_CATCH_EVENT, options, ProcessInstance, processInstance, payLoad );
    } else {
      ProcessInstance.emit(TOKEN_ARRIVED_EVENT, options, ProcessInstance, processInstance, token, delta);
    }
  };

    /**
     * terminate Sub-Processes
     * @param  {Object} options     Options
     * @param  {Object} flowObject  FlowObject
     * @param  {Object} message     Message
     */
  ProcessInstance.prototype._terminateSubProcesses = function _terminateSubProcesses(options, flowObject, message) {
    var self = this;
    var evaluatedProcessName = flowObject.subProcessId;
    if (flowObject.isCallActivity) {
      evaluatedProcessName = sandbox.evaluate$Expression(options, flowObject.subProcessId, message, self);
    }

    var filter = {where: {'processDefinitionName': evaluatedProcessName, '_status': 'running'}};
    self.subProcesses(filter, options, function fetchSP(err, subProcesses) {
      if (err) {
        log.error(options, err);
      }
      for (var i in subProcesses) {
        if (Object.prototype.hasOwnProperty.call(subProcesses, i)) {
          ProcessInstance.emit(SUBPROCESS_INTERRUPT_EVENT, options, ProcessInstance, subProcesses[i]);
        }
      }
    });
  };
};
