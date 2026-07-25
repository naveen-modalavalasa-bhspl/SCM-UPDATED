// @ts-nocheck
import React, { useState, useEffect } from "react";
import { Table, Button, Modal, Form, Input, Select, InputNumber, Switch, Radio, Space, Tag, Card, Spin } from "antd";
import { PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import { Tabs, Tab } from "@heroui/react";
import { MenuIcon } from "@/shared/layout/icons";
import api from "../config/api";

export function MastersLayout() {
  const [activeTab, setActiveTab] = useState("block");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [form] = Form.useForm();

  // Database-driven data state
  const [warehouses, setWarehouses] = useState([]);
  const [rawBins, setRawBins] = useState([]);

  // Form selection state
  const [selectedWarehouseId, setSelectedWarehouseId] = useState(null);
  const [attachmentType, setAttachmentType] = useState("shelf");

  // Fetch all databases (warehouses and bins)
  const fetchData = async () => {
    try {
      setLoading(true);
      const [whRes, binRes] = await Promise.all([
        api.get("/warehouses", { params: { page_size: 1000 } }),
        api.get("/bins", { params: { page_size: 1000 } }),
      ]);
      setWarehouses(whRes.data?.items || whRes.data || []);
      setRawBins(binRes.data?.items || binRes.data || []);
    } catch (err) {
      console.error("Failed to load warehouse master data:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Filtered lists for the table grids based on recursive hierarchy structure
  const getBlocks = () => rawBins.filter(b => b.bin_type === "ZONE" && b.level === 1);
  const getFloors = () => rawBins.filter(b => b.bin_type === "ZONE" && b.level === 2);
  const getLanes = () => rawBins.filter(b => b.bin_type === "ZONE" && b.level === 3);
  const getRacks = () => rawBins.filter(b => b.bin_type === "RACK");
  const getShelves = () => rawBins.filter(b => b.bin_type === "SHELF");
  const getBins = () => rawBins.filter(b => b.bin_type === "STORAGE");

  // Handle Form Submission - CRUD POST
  const handleAddMaster = async (values: any) => {
    try {
      let payload = {
        code: values.code,
        name: values.name || "",
        is_active: values.status !== false,
        is_pickable: true,
      };

      if (activeTab === "block") {
        payload.warehouse_id = values.warehouseId;
        payload.bin_type = "ZONE";
        payload.parent_id = null;
      } else if (activeTab === "floor") {
        const parent = rawBins.find(b => b.id === values.blockId);
        payload.warehouse_id = parent.warehouse_id;
        payload.parent_id = values.blockId;
        payload.bin_type = "ZONE";
      } else if (activeTab === "lane") {
        const parent = rawBins.find(b => b.id === values.floorId);
        payload.warehouse_id = parent.warehouse_id;
        payload.parent_id = values.floorId;
        payload.bin_type = "ZONE";
        payload.capacity_qty = values.width;
      } else if (activeTab === "rack") {
        const parent = rawBins.find(b => b.id === values.laneId);
        payload.warehouse_id = parent.warehouse_id;
        payload.parent_id = values.laneId;
        payload.bin_type = "RACK";
        payload.capacity_qty = values.maxWeight;
      } else if (activeTab === "shelf") {
        const parent = rawBins.find(b => b.id === values.rackId);
        payload.warehouse_id = parent.warehouse_id;
        payload.parent_id = values.rackId;
        payload.bin_type = "SHELF";
        payload.capacity_qty = values.height;
        payload.name = String(values.level); // Store shelf tier number as name
      } else if (activeTab === "bin") {
        payload.warehouse_id = values.warehouseId;
        payload.parent_id = values.parentId;
        payload.bin_type = "STORAGE";
        payload.capacity_qty = values.maxWeight;
        payload.name = values.barcode || values.code; // Store barcode in name
      }

      await api.post("/bins", payload);
      setIsModalOpen(false);
      form.resetFields();
      await fetchData();
    } catch (err) {
      console.error("Failed to save master record:", err);
      const detail = err.response?.data?.detail || "Validation or database error.";
      Modal.error({
        title: "Save Failed",
        content: typeof detail === "string" ? detail : JSON.stringify(detail),
      });
    }
  };

  // CRUD Delete Action
  const handleDelete = async (id: number) => {
    try {
      await api.delete(`/bins/${id}`);
      await fetchData();
    } catch (err) {
      console.error("Failed to delete record:", err);
      Modal.error({
        title: "Delete Failed",
        content: err.response?.data?.detail || "Check if this item is a parent to other nested levels.",
      });
    }
  };

  // Tab definitions
  const masterTabs = [
    { key: "block", name: "Block Master", icon: "columns" },
    { key: "floor", name: "Floor Master", icon: "list" },
    { key: "lane", name: "Lane / Aisle Master", icon: "list" },
    { key: "rack", name: "Rack Master", icon: "package" },
    { key: "shelf", name: "Shelf Master", icon: "file-text" },
    { key: "bin", name: "Bin Master", icon: "package" },
  ];

  // Helper resolvers for parent description mapping
  const getWarehouseName = (whId) => warehouses.find(w => w.id === whId)?.name || `Warehouse ${whId}`;
  const getParentCode = (pId) => rawBins.find(b => b.id === pId)?.code || `ID: ${pId}`;

  // Columns Mapping for Table grids
  const getColumns = () => {
    const actionsColumn = {
      title: "Actions",
      key: "actions",
      render: (_, record) => (
        <Button 
          type="text" 
          danger 
          icon={<DeleteOutlined />} 
          onClick={() => handleDelete(record.id)}
        >
          Delete
        </Button>
      ),
    };

    switch (activeTab) {
      case "block":
        return [
          { title: "Warehouse Location", dataIndex: "warehouse_id", key: "warehouse_id", render: (id) => getWarehouseName(id) },
          { title: "Block Code", dataIndex: "code", key: "code", render: (text) => <strong className="text-ink">{text}</strong> },
          { title: "Block Name", dataIndex: "name", key: "name" },
          actionsColumn
        ];
      case "floor":
        return [
          { title: "Parent Block", dataIndex: "parent_id", key: "parent_id", render: (pId) => getParentCode(pId) },
          { title: "Floor Code", dataIndex: "code", key: "code", render: (text) => <strong className="text-ink">{text}</strong> },
          { title: "Floor Name", dataIndex: "name", key: "name" },
          actionsColumn
        ];
      case "lane":
        return [
          { title: "Parent Floor", dataIndex: "parent_id", key: "parent_id", render: (pId) => getParentCode(pId) },
          { title: "Lane Code", dataIndex: "code", key: "code", render: (text) => <strong className="text-ink">{text}</strong> },
          { title: "Aisle Width (meters)", dataIndex: "capacity_qty", key: "capacity_qty", render: (val) => `${val || 0} m` },
          actionsColumn
        ];
      case "rack":
        return [
          { title: "Parent Lane", dataIndex: "parent_id", key: "parent_id", render: (pId) => getParentCode(pId) },
          { title: "Rack Code", dataIndex: "code", key: "code", render: (text) => <strong className="text-ink">{text}</strong> },
          { title: "Max Weight Capacity (kg)", dataIndex: "capacity_qty", key: "capacity_qty", render: (val) => `${Number(val || 0).toLocaleString()} kg` },
          actionsColumn
        ];
      case "shelf":
        return [
          { title: "Parent Rack", dataIndex: "parent_id", key: "parent_id", render: (pId) => getParentCode(pId) },
          { title: "Shelf Code", dataIndex: "code", key: "code", render: (text) => <strong className="text-ink">{text}</strong> },
          { title: "Shelf Level / Tier", dataIndex: "name", key: "name" },
          { title: "Height Clearance (cm)", dataIndex: "capacity_qty", key: "capacity_qty", render: (val) => `${val || 0} cm` },
          actionsColumn
        ];
      case "bin":
        return [
          { title: "Warehouse Location", dataIndex: "warehouse_id", key: "warehouse_id", render: (id) => getWarehouseName(id) },
          { title: "Attached To", dataIndex: "parent_id", key: "parent_id", render: (pId) => getParentCode(pId) },
          { title: "Bin Code", dataIndex: "code", key: "code", render: (text) => <strong className="text-ink">{text}</strong> },
          { title: "Barcode / RFID", dataIndex: "name", key: "name" },
          { title: "Max Weight (kg)", dataIndex: "capacity_qty", key: "capacity_qty", render: (val) => `${val || 0} kg` },
          { title: "Status", dataIndex: "is_active", key: "is_active", render: (status) => <Tag color={status ? "green" : "red"}>{status ? "Active" : "Inactive"}</Tag> },
          actionsColumn
        ];
      default:
        return [];
    }
  };

  // Resolve current active grid list
  const getDataSource = () => {
    switch (activeTab) {
      case "block": return getBlocks();
      case "floor": return getFloors();
      case "lane": return getLanes();
      case "rack": return getRacks();
      case "shelf": return getShelves();
      case "bin": return getBins();
      default: return [];
    }
  };

  // Bin Attachment dropdown filter
  const getParentOptions = () => {
    if (!selectedWarehouseId) return [];
    if (attachmentType === "shelf") {
      return getShelves().filter(b => b.warehouse_id === selectedWarehouseId);
    } else {
      return getRacks().filter(b => b.warehouse_id === selectedWarehouseId);
    }
  };

  if (loading && rawBins.length === 0) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "50vh" }}>
        <Spin size="large" tip="Loading Warehouse Masters from database..." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Tab Navigation header */}
      <div className="border-b border-line pb-1">
        <Tabs
          aria-label="Master sections"
          variant="underlined"
          color="primary"
          selectedKey={activeTab}
          onSelectionChange={(k) => setActiveTab(String(k))}
          classNames={{ tabList: "gap-4", cursor: "bg-brand", tab: "px-1 h-10" }}
        >
          {masterTabs.map((t) => (
            <Tab
              key={t.key}
              title={
                <span className="flex items-center gap-1.5 text-xs font-semibold text-muted hover:text-ink">
                  <MenuIcon name={t.icon} className="h-3.5 w-3.5 text-current" />
                  {t.name}
                </span>
              }
            />
          ))}
        </Tabs>
      </div>

      {/* Grid Display Card */}
      <Card 
        styles={{ body: { padding: "20px" } }} 
        style={{ borderRadius: "8px", border: "1px solid #E4E7EB", boxShadow: "0 2px 8px rgba(0,0,0,0.02)" }}
      >
        <div className="flex justify-between items-center mb-5">
          <div>
            <h2 className="text-lg font-bold text-ink" style={{ margin: 0 }}>
              {masterTabs.find(t => t.key === activeTab)?.name} Management
            </h2>
            <p className="text-xs text-muted" style={{ margin: 0 }}>
              Physical site master configuration synced directly with the database location schema.
            </p>
          </div>
          <Button 
            type="primary" 
            icon={<PlusOutlined />} 
            onClick={() => {
              form.resetFields();
              setSelectedWarehouseId(null);
              setAttachmentType("shelf");
              setIsModalOpen(true);
            }}
            style={{ background: "#F09000", borderColor: "#F09000", height: "38px", borderRadius: "6px" }}
          >
            Add New Record
          </Button>
        </div>

        <Table 
          columns={getColumns()} 
          dataSource={getDataSource()} 
          rowKey="id"
          pagination={{ pageSize: 8 }}
          loading={loading}
          style={{ background: "#FFFFFF" }}
        />
      </Card>

      {/* Modal Creation Forms */}
      <Modal
        title={`Create ${masterTabs.find(t => t.key === activeTab)?.name}`}
        open={isModalOpen}
        onCancel={() => setIsModalOpen(false)}
        onOk={() => form.submit()}
        okText="Save Master Record"
        okButtonProps={{ style: { background: "#F09000", borderColor: "#F09000" } }}
        destroyOnClose
        width={500}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleAddMaster}
          style={{ marginTop: "16px" }}
          initialValues={{ status: true, attachmentType: "shelf" }}
        >
          {/* 1. Block Master Form Fields */}
          {activeTab === "block" && (
            <>
              <Form.Item name="warehouseId" label="Warehouse" rules={[{ required: true, message: "Warehouse selection is required" }]}>
                <Select placeholder="Select Parent Warehouse">
                  {warehouses.map(w => <Select.Option key={w.id} value={w.id}>{w.name}</Select.Option>)}
                </Select>
              </Form.Item>
              <Form.Item name="code" label="Block Code" rules={[{ required: true, message: "Code is required" }]}>
                <Input placeholder="e.g. BLK-A" />
              </Form.Item>
              <Form.Item name="name" label="Block Name">
                <Input placeholder="e.g. North Wing" />
              </Form.Item>
            </>
          )}

          {/* 2. Floor Master Form Fields */}
          {activeTab === "floor" && (
            <>
              <Form.Item name="blockId" label="Warehouse / Block" rules={[{ required: true, message: "Parent Block is required" }]}>
                <Select placeholder="Select Parent Block">
                  {getBlocks().map(b => (
                    <Select.Option key={b.id} value={b.id}>
                      {getWarehouseName(b.warehouse_id)} / {b.code}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item name="code" label="Floor Code" rules={[{ required: true, message: "Code is required" }]}>
                <Input placeholder="e.g. FLR-01" />
              </Form.Item>
              <Form.Item name="level" label="Floor Level" rules={[{ required: true, message: "Numerical floor level is required" }]}>
                <InputNumber placeholder="0 for Ground, 1 for First Floor" style={{ width: "100%" }} min={0} />
              </Form.Item>
              <Form.Item name="name" label="Floor Name">
                <Input placeholder="e.g. Ground Floor" />
              </Form.Item>
            </>
          )}

          {/* 3. Lane / Aisle Master Form Fields */}
          {activeTab === "lane" && (
            <>
              <Form.Item name="floorId" label="Floor" rules={[{ required: true, message: "Parent Floor is required" }]}>
                <Select placeholder="Select Parent Floor">
                  {getFloors().map(f => (
                    <Select.Option key={f.id} value={f.id}>
                      {getParentCode(f.parent_id)} / {f.code}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item name="code" label="Lane Code" rules={[{ required: true, message: "Code is required" }]}>
                <Input placeholder="e.g. LANE-12" />
              </Form.Item>
              <Form.Item name="width" label="Aisle Width (meters)" rules={[{ required: true, message: "Clearance width is required" }]}>
                <InputNumber placeholder="Clearance space in meters" style={{ width: "100%" }} min={0.1} step={0.1} />
              </Form.Item>
            </>
          )}

          {/* 4. Rack Master Form Fields */}
          {activeTab === "rack" && (
            <>
              <Form.Item name="laneId" label="Lane" rules={[{ required: true, message: "Parent Lane selection is required" }]}>
                <Select placeholder="Select Parent Lane">
                  {getLanes().map(l => (
                    <Select.Option key={l.id} value={l.id}>
                      {getParentCode(l.parent_id)} / {l.code}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item name="code" label="Rack Code" rules={[{ required: true, message: "Code is required" }]}>
                <Input placeholder="e.g. RCK-04" />
              </Form.Item>
              <Form.Item name="maxWeight" label="Max Weight Capacity (kg)" rules={[{ required: true, message: "Max load limit is required" }]}>
                <InputNumber placeholder="Weight capacity limit" style={{ width: "100%" }} min={1} />
              </Form.Item>
            </>
          )}

          {/* 5. Shelf Master Form Fields */}
          {activeTab === "shelf" && (
            <>
              <Form.Item name="rackId" label="Rack" rules={[{ required: true, message: "Parent Rack selection is required" }]}>
                <Select placeholder="Select Parent Rack">
                  {getRacks().map(r => (
                    <Select.Option key={r.id} value={r.id}>
                      {getParentCode(r.parent_id)} / {r.code}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item name="code" label="Shelf Code" rules={[{ required: true, message: "Code is required" }]}>
                <Input placeholder="e.g. SHF-03" />
              </Form.Item>
              <Form.Item name="level" label="Shelf Level / Tier" rules={[{ required: true, message: "Shelf tier level is required" }]}>
                <InputNumber placeholder="Position index (e.g. 1, 2, 3)" style={{ width: "100%" }} min={1} />
              </Form.Item>
              <Form.Item name="height" label="Height Clearance (cm)" rules={[{ required: true, message: "Height clearance is required" }]}>
                <InputNumber placeholder="Vertical space clearance in cm" style={{ width: "100%" }} min={1} />
              </Form.Item>
            </>
          )}

          {/* 6. Bin Master Form Fields */}
          {activeTab === "bin" && (
            <>
              <Form.Item name="warehouseId" label="Warehouse" rules={[{ required: true, message: "Warehouse is required" }]}>
                <Select 
                  placeholder="Select Warehouse Location"
                  onChange={(val) => {
                    setSelectedWarehouseId(val);
                    form.setFieldsValue({ parentId: undefined });
                  }}
                >
                  {warehouses.map(w => <Select.Option key={w.id} value={w.id}>{w.name}</Select.Option>)}
                </Select>
              </Form.Item>
              
              <Form.Item name="attachmentType" label="Attachment Type" rules={[{ required: true }]}>
                <Radio.Group 
                  onChange={(e) => {
                    setAttachmentType(e.target.value);
                    form.setFieldsValue({ parentId: undefined });
                  }} 
                  buttonStyle="solid"
                >
                  <Radio.Button value="shelf">Attach to Shelf</Radio.Button>
                  <Radio.Button value="rack">Attach directly to Rack</Radio.Button>
                </Radio.Group>
              </Form.Item>
              
              <Form.Item 
                name="parentId" 
                label={attachmentType === "shelf" ? "Select Shelf Parent" : "Select Rack Parent"} 
                rules={[{ required: true, message: "Parent selection is required" }]}
              >
                <Select placeholder={attachmentType === "shelf" ? "Choose Shelf" : "Choose Rack"}>
                  {getParentOptions().map(p => (
                    <Select.Option key={p.id} value={p.id}>
                      {getParentCode(p.parent_id)} / {p.code}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>

              <Form.Item name="code" label="Bin Code" rules={[{ required: true, message: "Code is required" }]}>
                <Input placeholder="e.g. BIN-A1-S2-B5" />
              </Form.Item>
              <Form.Item name="barcode" label="Barcode / RFID String">
                <Input placeholder="Scannable label (Optional; defaults to Code if left blank)" />
              </Form.Item>
              <Form.Item name="maxWeight" label="Max Weight Capacity (kg)" rules={[{ required: true, message: "Max weight capacity is required" }]}>
                <InputNumber placeholder="Weight limit" style={{ width: "100%" }} min={0.1} step={0.5} />
              </Form.Item>
              <Form.Item name="status" label="Bin Active Status" valuePropName="checked">
                <Switch checkedChildren="Active" unCheckedChildren="Inactive" />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </div>
  );
}

export default MastersLayout;
