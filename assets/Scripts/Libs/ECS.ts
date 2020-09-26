export module ecs {
    //#region 类型声明
    type ComponentConstructor<T> = {
        /**
         * 每类组件的唯一id
         */
        tid?: number;
        /**
         * 组件名称，可用作实体对象的属性名称。
         */
        compName?: string;
        new() : T;
    }
    type ComponentAddOrRemove = (entity: Entity) => void;
    //#endregion

    export let context: Context = null;
    /**
     * 组件可能是从组件缓存池中取出来的，这个时候组件中的数据是销毁前的数据，这可能会导致逻辑行为的不确定。
     * 所以在得到组件后要注意某些数据的初始化工作。
     * 
     * 组件里面只放数据可能在实际写代码的时候比较麻烦。如果是单纯对组件内的数据操作可以在组件里面写方法。
     */
    export interface IComponent { }
    
    /**
     * 组件类型id
     */
    let compTid = 0;
    /**
     * 组件构造函数
     */
    let componentConstructors: ComponentConstructor<IComponent>[] = [];
    /**
     * 由于js打包会改变类名，所以这里必须手动传入组件的名称。
     * @param componentName 
     */
    export function register(componentName: string) {
        return function (ctor: ComponentConstructor<IComponent>) {
            if (ctor.tid == null) {
                ctor.tid = compTid++;
                ctor.compName = componentName;
                componentConstructors.push(ctor);
            }
            else {
                throw new Error('already contain component ' + componentName);
            }
        }
    }

    /**
     * 为了增强实体的扩展性，实体的构造函数需要从外部传递进来。
     * @param eCtor 实体构造函数
     */
    export function initContext() {
        if(context == null) {
            context = new Context();
        }
    }

    /**
     * 指定一个组件创建实体，返回组件对象。
     * @param ctor 
     */
    export function createEntityWithComp<T extends IComponent>(ctor: ComponentConstructor<T>): T {
        return context.createEntityWithComp(ctor);
    }

    /**
     * 指定多个组件创建实体，返回实体对象。
     * @param ctors 
     */
    export function createEntityWithComps<E extends Entity>(...ctors: ComponentConstructor<IComponent>[]): E {
        return context.createEntityWithComps(...ctors) as E;
    }

    //#region 单例组件
    let tid2comp: Map<number, IComponent> = new Map();
    /**
     * 获取单例组件
     * @param ctor 组件类
     */
    export function getSinglton<T extends IComponent>(ctor: ComponentConstructor<T>) {
        if(!tid2comp.has(ctor.tid)) {
            let comp = createEntityWithComp(ctor);
            tid2comp.set(ctor.tid, comp);
        }
        return tid2comp.get(ctor.tid) as T;
    }
    //#endregion

    export class Context {

        /**
         * 组件缓存池
         */
        private componentPools: Array<Array<IComponent>> = null;
        /**
         * 实体对象缓存池
         */
        private entityPool: Entity[] = [];

        /**
         * 通过实体id查找实体对象
         */
        private eid2Entity: Map<number, Entity> = new Map();

        /**
         * 当前Context下组件类型数量
         */
        public readonly totalComponents: number = 0;
        /**
         * 每个类型组件对应的构造函数
         */
        public readonly componentTypes: ComponentConstructor<IComponent>[];

        /**
         * 每个组件的添加和删除的动作都要派送到“关心”它们的group上。
         */
        private readonly componentAddOrRemove: Array<Array<ComponentAddOrRemove>> = null;

        private groups: Map<string, Group> = new Map();

        constructor() {
            this.totalComponents = componentConstructors.length;
            this.componentTypes = componentConstructors;

            this.componentPools = new Array<Array<IComponent>>(this.totalComponents);
            this.componentAddOrRemove = new Array<Array<ComponentAddOrRemove>>(this.totalComponents);

            for (let i = 0; i < this.totalComponents; i++) {
                this.componentPools[i] = [];
                this.componentAddOrRemove[i] = [];
            }
            if (this.totalComponents > 64) {
                throw new Error('最多支持64种组件！');
            }
        }

        /**
         * 为了管理到每一个创建的Entity，需要通过Context去创建。
         */
        createEntity<E extends Entity = Entity>(): E {
            let entity = this.entityPool.pop() || new Entity();
            entity.reset(this);
            this.eid2Entity.set(entity.eid, entity);
            return entity as E;
        }

        /**
         * 指定一个组件创建实体，返回组件对象。
         * @param ctor 
         */
        createEntityWithComp<T extends IComponent>(ctor: ComponentConstructor<T>): T {
            let entity = this.createEntity();
            return entity.add(ctor);
        }

        /**
         * 指定多个组件创建实体，返回实体对象。
         * @param ctors 
         */
        createEntityWithComps<E extends Entity = Entity>(...ctors: ComponentConstructor<IComponent>[]): E {
            let entity = this.createEntity();
            for(let ctor of ctors) {
                entity.add(ctor);
            }
            return entity as E;
        }

        /**
         * 销毁实体。
         * 
         * Context会缓存销毁的实体，下次新建实体时会优先从缓存中拿。
         * @param entity 
         */
        destroyEntity(entity: Entity) {
            if (this.eid2Entity.has(entity.eid)) {
                this.entityPool.push(entity);
                this.eid2Entity.delete(entity.eid);
            }
            else {
                console.warn('实体没有通过Context对象的createEntity创建或者该实体重复销毁', entity.eid);
            }
        }

        /**
         * 创建group，每个group只关心对应组件的添加和删除
         * @param matchCompTypeIds 
         * @param systemType e-表示ExecuteSystem，r-表示ReactiveSystem，c-表示在系统中自己手动调用createGroup创建的筛选规则
         */
        createGroup<E extends Entity = Entity>(matcher: IMatcher, systemType: string = 'c'): Group<E> {
            let key = `${systemType}_${matcher.getKey()}`;
            let group = this.groups.get(key);
            if (!group) {
                group = new Group(matcher);
                this.groups.set(key, group);
                let careComponentTypeIds = matcher.indices;
                for (let i = 0, len = careComponentTypeIds.length; i < len; i++) {
                    this.componentAddOrRemove[careComponentTypeIds[i]].push(group.onComponentAddOrRemove.bind(group));
                }
            }
            return group as Group<E>;
        }

        clear() {
            this.groups.forEach((group) => {
                group.clear();
            });
            this.eid2Entity.forEach((entity) => {
                entity.destroy();
            });
        }

        createComponent<T extends IComponent>(ctor: ComponentConstructor<T>): T {
            let component = this.componentPools[ctor.tid].pop() || new this.componentTypes[ctor.tid];
            return component as T;
        }

        putComponent(componentTypeId: number, component: IComponent) {
            this.componentPools[componentTypeId].push(component);
        }

        /**
         * 实体身上组件有增删操作，广播通知对应的观察者。
         * @param entity 实体对象
         * @param componentTypeId 组件类型id
         */
        broadcastComponentAddOrRemove(entity: Entity, componentTypeId: number) {
            let events = this.componentAddOrRemove[componentTypeId];
            for (let i = events.length - 1; i >= 0; i--) {
                events[i](entity);
            }
            // 判断是不是删了单例组件
            if(tid2comp.has(componentTypeId)) {
                tid2comp.delete(componentTypeId);
            }
        }

        getEntityByEid<E extends Entity = Entity>(eid: number): E {
            return this.eid2Entity.get(eid) as E;
        }

        activeEntityCount() {
            return this.eid2Entity.size;
        }
    }

    class Mask {
        private mask: Uint32Array = null;

        constructor() {
            let length = Math.ceil(compTid / 32);
            this.mask = new Uint32Array(length);
        }

        set(num: number) {
            this.mask[((num / 32) >>> 0)] |= (1 << (num % 32));
        }

        delete(num: number) {
            this.mask[((num / 32) >>> 0)] &= ~(1 << (num % 32));
        }

        has(num: number) {
            return !!(this.mask[((num / 32) >>> 0)] & (1 << (num % 32)));
        }

        or(other: Mask) {
            for(let i = 0, len = this.mask.length; i < len; i++) {
                if(this.mask[i] & other.mask[i]) {
                    return true;
                }
            }
            return false;
        }

        and(other: Mask) {
            for(let i = 0, len = this.mask.length; i < len; i++) {
                if((this.mask[i] & other.mask[i]) != this.mask[i]) {
                    return false;
                }
            }
            return true;
        }

        clear() {
            for(let i = 0, len = this.mask.length; i < len; i++) {
                this.mask[i] = 0;
            }
        }
    }

    export class Entity {
        /**
         * 实体id自增量
         */
        private static eid: number = 1;
        /**
         * 实体唯一标识
         */
        public readonly eid: number = -1;

        public mask = new Mask();

        /**
         * 当前实体身上附加的组件构造函数
         */
        private compTid2Ctor: Map<number, ComponentConstructor<IComponent>> = new Map();

        public context: Context;

        constructor() {
            this.eid = Entity.eid++;
        }

        reset(context: Context) {
            this.context = context;
        }

        /**
         * 根据组件id动态创建组件，并通知关心的系统。
         * 
         * 如果实体存在了这个组件，那么会先删除之前的组件然后添加新的。
         * 
         * 注意：不要直接new Component，new来的Component不会从Component的缓存池拿缓存的数据。
         * @param componentTypeId 组件id
         */
        add<T extends IComponent>(ctor: ComponentConstructor<T>): T {
            if (!this.context) {
                console.warn('entity already destroyed.', this.eid);
                return;
            }

            let componentTypeId = ctor.tid;
            if(this.mask.has(componentTypeId)) {// 判断是否有该组件，如果有则先移除
                this.remove(ctor);
            }
            this.mask.set(componentTypeId);

            // 创建组件对象
            let component = this.context.createComponent(ctor);
            // 将组件对象直接附加到实体对象身上，方便直接获取。
            this[ctor.compName] = component;

            this.compTid2Ctor.set(componentTypeId, ctor);
            // 广播实体添加组件的消息
            this.context.broadcastComponentAddOrRemove(this, componentTypeId);
            return component;
        }

        get<T extends IComponent>(ctor: ComponentConstructor<T>): T {
            return this[ctor.compName];
        }

        has<T extends IComponent>(ctor: ComponentConstructor<T>): boolean {
            return !!this.get(ctor);
        }

        remove<T extends IComponent>(ctor: ComponentConstructor<T>) {
            let componentTypeId = ctor.tid;
            if(this.mask.has(componentTypeId)) {
                this.context.putComponent(componentTypeId, this[ctor.compName]);
                this[ctor.compName] = null;
                this.mask.delete(componentTypeId);
                this.context.broadcastComponentAddOrRemove(this, componentTypeId);
                this.compTid2Ctor.delete(componentTypeId);
            }
        }

        /**
         * 销毁实体，实体会被回收到实体缓存池中。
         */
        destroy() {
            for(let ctor of this.compTid2Ctor.values()) {
                this.mask.delete(ctor.tid);
                this.context.broadcastComponentAddOrRemove(this, ctor.tid);
                this[ctor.compName] = null;
            }
            this.compTid2Ctor.clear();
            this.mask.clear();
            this.context.destroyEntity(this);
            this.context = null;
        }
    }
    

    export class Group<E extends Entity = Entity> {
        /**
         * 实体筛选规则
         */
        private matcher: IMatcher;

        
        private _matchEntities: Map<number, E> = new Map();

        private _entitiesCache: E[] = null;

        /**
         * 符合规则的实体
         */
        public get matchEntities() {
            if(this._entitiesCache === null) {
                this._entitiesCache = Array.from(this._matchEntities.values());
            }
            return this._entitiesCache;
        }

        /**
         * 当前group中实体的数量。
         * 
         * 不要手动修改这个属性值。
         */
        public count = 0; // 其实可以通过this._matchEntities.size获得实体数量，但是需要封装get方法。为了减少一次方法的调用所以才直接创建一个count属性

        /**
         * 获取matchEntities中第一个实体
         */
        get entity(): E {
            return this.matchEntities[0];
        }

        constructor(matcher: IMatcher) {
            this.matcher = matcher;
        }

        /**
         * 实体添加或删除组件回调
         * @param entity 
         * @param ctid 组件id；如果实体添加组件，是不需要传ctid，那么它的默认值就是-1；如果实体移除组件，则会传递被移除组件的组件类型id过来
         */
        onComponentAddOrRemove(entity: E) {
            if (this.matcher.isMatch(entity)) { // Group只关心指定组件在实体身上的添加和删除动作。
                this._matchEntities.set(entity.eid, entity);
                this._entitiesCache = null;
                this.count++;
            }
            else if(this._matchEntities.has(entity.eid)) { // 如果Group中有这个实体，但是这个实体已经不满足匹配规则，则从Group中移除该实体
                this._matchEntities.delete(entity.eid);
                this._entitiesCache = null;
                this.count--;
            }
        }

        clear() {
            this._matchEntities.clear();
            this._entitiesCache = null;
            this.count = 0;
        }
    }

    abstract class BaseOf {
        protected mask = new Mask();
        public indices: number[] = [];
        constructor(...args: number[]) {
            let componentTypeId = -1;
            let len = args.length;
            for (let i = 0; i < len; i++) {
                componentTypeId = args[i];
                if(componentTypeId == -1) {
                    throw Error('存在没有注册的组件！');
                }
                this.mask.set(componentTypeId);

                if (this.indices.indexOf(args[i]) < 0) { // 去重
                    this.indices.push(args[i]);
                }
            }
            if(len > 1) {
                this.indices.sort((a, b) => { return a - b; }); // 对组件类型id进行排序，这样关注相同组件的系统就能共用同一个group
            }
        }

        public toString(): string {
            return this.indices.join('-'); // 生成group的key
        }

        public abstract getKey(): string;

        public abstract isMatch(entity: Entity): boolean;
    }

    /**
     * 用于描述包含任意一个这些组件的实体
     */
    class AnyOf extends BaseOf {
        public isMatch(entity: Entity): boolean {
            return this.mask.or(entity.mask);
        }

        getKey(): string {
            return 'anyOf:' + this.toString();
        }
    }

    /**
     * 用于描述包含了“这些”组件的实体，这个实体除了包含这些组件还可以包含其他组件
     */
    class AllOf extends BaseOf {
        public isMatch(entity: Entity): boolean {
            return this.mask.and(entity.mask);
        }

        getKey(): string {
            return 'allOf:' + this.toString();
        }
    }

    /**
     * 不包含所有这里面的组件（“与”关系）
     */
    class ExcludeOf extends BaseOf {

        public getKey(): string {
            return 'excludeOf:' + this.toString();
        }

        public isMatch(entity: Entity): boolean {
            return !this.mask.or(entity.mask);
        }
    }

    export interface IMatcher {
        indices: number[];
        getKey(): string;
        isMatch(entity: Entity): boolean;
    }

    /**
     * 筛选规则间是“与”的关系
     * 比如：ecs.Macher.allOf(...).excludeOf(...)表达的是allOf && excludeOf，即实体有“这些组件” 并且 “没有这些组件”
     */
    export class Matcher implements IMatcher {

        protected rules: BaseOf[] = [];
        protected _indices: number[] = null;
        /**
         * 匹配器关注的组件索引。在创建Group时，Context根据组件id去给Group关联组件的添加和移除事件。
         */
        public get indices() {
            if (this._indices === null) {
                this._indices = [];
                this.rules.forEach((rule) => {
                    Array.prototype.push.apply(this._indices, rule.indices);
                });
            }
            return this._indices;
        }

        /**
         * 表示只关心这些组件的添加和删除动作。虽然实体可能有这些组件之外的组件，但是它们的添加和删除没有被关注，所以不会存在对关注之外的组件
         * 进行添加操作引发Group重复添加实体。
         * @param args 
         */
        public static allOf(...args: ComponentConstructor<IComponent>[]) {
            return new Matcher().allOf(...args);
        }

        public static anyOf(...args: ComponentConstructor<IComponent>[]) {
            return new Matcher().anyOf(...args);
        }

        public static onlyOf(...args: ComponentConstructor<IComponent>[]) {
            return new Matcher().onlyOf(...args);
        }

        public static excludeOf(...args: ComponentConstructor<IComponent>[]) {
            return new Matcher().excludeOf(...args);
        }

        /**
         * 组件间是或的关系，表示关注拥有任意一个这些组件的实体。
         * @param args 组件索引
         */
        public anyOf(...args: ComponentConstructor<IComponent>[]): Matcher {
            let newArgs = [];
            for (let i = 0, len = args.length; i < len; i++) {
                newArgs.push(args[i].tid);
            }
            this.rules.push(new AnyOf(...newArgs));
            return this;
        }

        /**
         * 组件间是与的关系，表示关注拥有所有这些组件的实体。
         * @param args 组件索引
         */
        public allOf(...args: ComponentConstructor<IComponent>[]): Matcher {
            let newArgs = [];
            for (let i = 0, len = args.length; i < len; i++) {
                newArgs.push(args[i].tid);
            }
            this.rules.push(new AllOf(...newArgs));
            return this;
        }

        /**
         * 表示关注只拥有这些组件的实体
         * 
         * 注意：
         *  不是特殊情况不建议使用onlyOf。因为onlyOf会监听所有组件的添加和删除事件。
         * @param args 组件索引
         */
        public onlyOf(...args: ComponentConstructor<IComponent>[]): Matcher {
            let newArgs = [];
            for (let i = 0, len = args.length; i < len; i++) {
                newArgs.push(args[i].tid);
            }
            this.rules.push(new AllOf(...newArgs));
            let ctors = componentConstructors;
            let otherTids = [];
            for(let ctor of ctors) {
                if(newArgs.indexOf(ctor.tid) < 0) {
                    otherTids.push(ctor.tid);
                }
            }
            this.rules.push(new ExcludeOf(...otherTids));
            return this;
        }

        /**
         * 表示不包含所有这里面的组件（“与”关系）。
         * @param args 
         */
        public excludeOf(...args: ComponentConstructor<IComponent>[]) {
            let newArgs = [];
            for (let i = 0, len = args.length; i < len; i++) {
                newArgs.push(args[i].tid);
            }
            this.rules.push(new ExcludeOf(...newArgs));
            return this;
        }

        public getKey(): string {
            let s = '';
            for (let i = 0; i < this.rules.length; i++) {
                s += this.rules[i].getKey()
                if (i < this.rules.length - 1) {
                    s += ' && '
                }
            }
            return s;
        }

        public isMatch(entity: Entity): boolean {
            if (this.rules.length === 1) {
                return this.rules[0].isMatch(entity);
            }
            else if (this.rules.length === 2) {
                return this.rules[0].isMatch(entity) && this.rules[1].isMatch(entity);
            } 
            else {
                for(let rule of this.rules) {
                    if(!rule.isMatch(entity)) {
                        return false;
                    }
                }
                return true;
            }
        }
    }

    /**
     * 用来表示“或”关系的筛选规则
     * 比如：ecs.OrMacher.or(ecs.Matcher.allOf(...), ecs.Macher.allOf(...))表示allOf || allOf，即实体“有这些组件” 或者 “有这些组件”。
     */
    export class OrMatcher extends Matcher {

        public static allOf(...args: ComponentConstructor<IComponent>[]) {
            return new OrMatcher().allOf(...args);
        }

        public static anyOf(...args: ComponentConstructor<IComponent>[]) {
            return new OrMatcher().anyOf(...args);
        }

        public static onlyOf(...args: ComponentConstructor<IComponent>[]) {
            return new OrMatcher().onlyOf(...args);
        }

        public static excludeOf(...args: ComponentConstructor<IComponent>[]) {
            return new OrMatcher().excludeOf(...args);
        }
        
        getKey(): string {
            let s = '';
            for(let i = 0, len = this.rules.length; i < len; i++) {
                s += this.rules[i].getKey();
                if(i < len - 1) {
                    s += ' || ';
                }
            }
            return s;
        }

        isMatch(entity: Entity): boolean {
            if(this.rules.length === 2) {
                return this.rules[0].isMatch(entity) || this.rules[1].isMatch(entity);
            }
            else if(this.rules.length === 1) {
                return this.rules[0].isMatch(entity);
            }
            else {
                for(let rule of this.rules) {
                    if(rule.isMatch(entity)) {
                        return true;
                    }
                }
                return false;
            }
        }
    }

    //----------------------------------------------------------------------------------------------------
    export interface ISystem {

    }

    //----------------------------------------------------------------------------------------------------
    export interface IExecuteSystem extends ISystem {
        readonly group: Group;
        init(): void;
        execute(dt: number): void;
    }
    //----------------------------------------------------------------------------------------------------
    export interface IReactiveSystem extends IExecuteSystem {

    }
    //----------------------------------------------------------------------------------------------------
    export interface IRExecuteSystem extends IExecuteSystem {
        readonly group: Group;
        readonly rGroup: Group;

        init(): void;
        execute(dt: number): void;
    }

    /**
     * 每一帧都会去执行的系统
     */
    export abstract class ExecuteSystem<E extends Entity = Entity> implements IExecuteSystem {

        /**
         * 当前系统关心的组件
         */
        public readonly group: Group<E>;

        /**
         * 帧时间
         */
        protected dt: number = 0;

        constructor() {
            this.group = context.createGroup(this.filter(), 'e');
        }

        /**
         * 不需要经过group的判断，无条件执行。
         */
        init(): void {

        }

        execute(dt: number): void {
            this.dt = dt;
            this.update(this.group.matchEntities);
        }
        /**
         * 实体过滤规则
         * 
         * 根据提供的组件过滤实体。
         */
        abstract filter(): Matcher;
        abstract update(entities: E[]): void;
    }
    /**
     * 响应式的系统，如果收集到实体则只执行一次，每次执行完后都会移除当前收集的实体，直到再次收集到实体。
     * 
     */
    export abstract class ReactiveSystem<E extends Entity = Entity> implements IReactiveSystem {

        /**
         * 当前系统关心的组件
         */
        public readonly group: Group<E>;
        protected dt: number = 0;

        constructor() {
            this.group = context.createGroup(this.filter(), 'r');
        }

        init() {

        }

        execute(dt: number): void {
            this.dt = dt;
            this.update(this.group.matchEntities);
            this.group.clear();
        }
        /**
         * 实体过滤规则
         * 
         * 根据提供的组件过滤实体。
         */
        abstract filter(): Matcher;
        abstract update(entities: E[]): void;
    }

    /**
     * 自动回收实体的ReactiveSystem。
     */
    export abstract class AutoDestroyEntityReactiveSystem<E extends Entity = Entity> extends ReactiveSystem<E> {
        execute(dt: number): void {
            this.dt = dt;
            this.update(this.group.matchEntities as E[]);
            for(let e of this.group.matchEntities) {
                e.destroy();
            }
            this.group.clear();
        }
    }

    /**
     * 结合ExecuteSystem和ReactiveSystem的特性，可以同时处理实体进入System的逻辑，和每帧的逻辑。
     */
    export abstract class RExecuteSystem<E extends Entity = Entity> implements IRExecuteSystem {
        public readonly group: Group;
        public readonly rGroup: Group;
        protected dt: number = 0;

        constructor() {
            this.group = context.createGroup(this.filter(), 'e');
            this.rGroup = context.createGroup(this.filter(), 'r');
        }

        init(): void {
            
        }

        execute(dt: number): void {
            this.dt = dt;
            // 处理刚进来的实体
            if(this.rGroup.count > 0) {
                this.entityEnter(this.rGroup.matchEntities as E[]);
                this.rGroup.clear();
            }
            // 
            this.update(this.group.matchEntities as E[]);
        }
        
        /**
         * 实体过滤规则
         * 
         * 根据提供的组件过滤实体。
         */
        abstract filter(): IMatcher;
        abstract entityEnter(entities: E[]): void;
        abstract update(entities: E[]): void;
    }

    /**
     * System的root，对游戏中的System遍历从这里开始。
     */
    export class RootSystem implements ISystem {
        private executeSystemFlows: IExecuteSystem[] = [];

        private debugInfo: HTMLElement;
        private executeCount: {[key: string]: number} = null;

        constructor() {
            
        }

        initDebug() {
            this.executeCount = Object.create(null);
            this.debugInfo = document.createElement('debugInfo');
            this.debugInfo.style.position = 'absolute'
            this.debugInfo.style.top = '60px';
            this.debugInfo.style.left = '10px';
            this.debugInfo.style.color = '#ffffff';
            document.body.appendChild(this.debugInfo);

            for(let sys of this.executeSystemFlows) {
                this.executeCount[sys['__proto__'].constructor.name] = 0;
            }
        }

        add(system: ISystem) {
            if (system instanceof System) { // 将嵌套的System都“摊平”，放在根System中进行遍历，减少execute的频繁进入退出。
                Array.prototype.push.apply(this.executeSystemFlows, system.executeSystems);
                system.executeSystems.length = 0;
            }
            else {
                this.executeSystemFlows.push(system as IExecuteSystem);
            }
            return this;
        }

        init() {
            for (let sys of this.executeSystemFlows) {
                sys.init();
            }
        }

        execute(dt: number) {
            for (let sys of this.executeSystemFlows) {
                if (sys.group.count > 0) { // 与System关联的Group如果没有实体，则不去执行这个System。
                    sys.execute(dt);
                }
            }
        }

        debugExecute(dt: number) {
            let s = '';
            for (let sys of this.executeSystemFlows) {
                let sysName = sys['__proto__'].constructor.name;
                let startTime = Date.now();
                if (sys.group.count > 0) { // 与System关联的Group如果没有实体，则不去执行这个System。
                    sys.execute(dt);
                    this.executeCount[sysName]++;
                }
                
                let endTime = Date.now();
                let color = sys.group.count === 0 ? 'white' : 'green'
                s += `<font size="1" color="${color}">${sysName}: ${endTime - startTime} ms\n`;
                if(sys instanceof ReactiveSystem) {
                    s += `  |_execute count: ${this.executeCount[sysName]}\n`;
                }
                if(sys.group.count > 0) {
                    s += `  |_entity count: ${sys.group.count}\n`;
                }
                s += '</font>';
            }
            s += `Active entity count: ${context.activeEntityCount()}`;
            this.debugInfo.innerHTML = `<pre>${s}</pre>`;
        }
    }

    /**
     * 系统组合器，用于将多个相同功能模块的系统逻辑上放在一起。System也可以嵌套System。
     */
    export class System implements ISystem {
        executeSystems: IExecuteSystem[] = [];

        constructor() {

        }

        add(system: ISystem) {
            if (system instanceof System) {
                Array.prototype.push.apply(this.executeSystems, system.executeSystems);
                system.executeSystems.length = 0;
            }
            else {
                this.executeSystems.push(system as IExecuteSystem);
            }
            return this;
        }
    }
}