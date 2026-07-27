import { useState, useEffect } from "react";
import { Table, Button, Modal, Form, Input, Select, InputNumber, Tag, Card, Space, message, Row, Col } from "antd";
import { PlusOutlined, CheckOutlined, CloseOutlined, ReloadOutlined } from "@ant-design/icons";
import { listStockAdjustments, createStockAdjustment, approveStockAdjustment, rejectStockAdjustment, inventoryApi } from "../api";
import type { WarehouseOption, CatalogItemOption } from "../types";

export function StockAdjustmentsView() {
  const [adjustments, setAdjustments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);
  const [items, setItems] = useState<CatalogItemOption[]>([]);
  const [form] = Form.useForm();

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await listStockAdjustments();
      setAdjustments(res.items || []);
    } catch (e) {
      console.error(e);
      message.error("Failed to load stock adjustments");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    inventoryApi.getWarehouses().then(setWarehouses).catch(console.error);
    inventoryApi.getCatalogItems().then(setItems).catch(console.error);
  }, []);

  const handleCreate = async (values: any) => {
    setSubmitting(true);
    try {
      await createStockAdjustment({
        warehouse_id: values.warehouse_id,
        reason: values.reason,
        remarks: values.remarks,
        items: [
          {
            item_id: values.item_id,
            direction: values.direction,
            quantity: values.quantity,
            unit_cost: values.unit_cost || 0,
            remarks: values.item_remarks,
          },
        ],
      });
      message.success("Stock adjustment created successfully");
      setIsModalOpen(false);
      form.resetFields();
      loadData();
    } catch (e: any) {
      console.error(e);
      message.error(e?.response?.data?.detail || "Failed to create adjustment");
    } finally {
      setSubmitting(false);
    }
  };

  const handleApprove = async (id: number) => {
    try {
      await approveStockAdjustment(id);
      message.success("Adjustment approved & posted to stock");
      loadData();
    } catch (e: any) {
      message.error(e?.response?.data?.detail || "Failed to approve adjustment");
    }
  };

  const handleReject = async (id: number) => {
    try {
      await rejectStockAdjustment(id);
      message.info("Adjustment rejected");
      loadData();
    } catch (e: any) {
      message.error(e?.response?.data?.detail || "Failed to reject adjustment");
    }
  };

  const columns = [
    { title: "Adj No", dataIndex: "adjustment_no", key: "adjustment_no", render: (text: string) => <strong>{text}</strong> },
    { title: "Warehouse", dataIndex: "warehouse_name", key: "warehouse_name" },
    { title: "Reason", dataIndex: "reason", key: "reason", render: (r: string) => <Tag color="blue">{r}</Tag> },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (s: string) => {
        const color = s === "APPROVED" ? "green" : s === "REJECTED" ? "red" : "orange";
        return <Tag color={color}>{s}</Tag>;
      },
    },
    { title: "Created By", dataIndex: "created_by_name", key: "created_by_name" },
    { title: "Created At", dataIndex: "created_at", key: "created_at", render: (d: string) => d ? new Date(d).toLocaleString() : "-" },
    {
      title: "Actions",
      key: "actions",
      render: (_: any, record: any) => (
        <Space>
          {record.status === "PENDING_APPROVAL" && (
            <>
              <Button type="primary" size="small" icon={<CheckOutlined />} onClick={() => handleApprove(record.id)}>
                Approve
              </Button>
              <Button danger size="small" icon={<CloseOutlined />} onClick={() => handleReject(record.id)}>
                Reject
              </Button>
            </>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Stock Adjustments</h2>
        </Col>
        <Col>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={loadData}>Refresh</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setIsModalOpen(true)}>
              New Adjustment
            </Button>
          </Space>
        </Col>
      </Row>

      <Card bordered>
        <Table dataSource={adjustments} columns={columns} rowKey="id" loading={loading} pagination={{ pageSize: 10 }} />
      </Card>

      <Modal
        title="Create Stock Adjustment"
        open={isModalOpen}
        onCancel={() => setIsModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
      >
        <Form form={form} layout="vertical" onFinish={handleCreate} initialValues={{ direction: "IN", reason: "COUNT_VARIANCE" }}>
          <Form.Item name="warehouse_id" label="Warehouse" rules={[{ required: true, message: "Select warehouse" }]}>
            <Select placeholder="Select warehouse">
              {warehouses.map((w) => (
                <Select.Option key={w.id} value={w.id}>{w.name}</Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item name="reason" label="Reason" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="DAMAGE">Damage</Select.Option>
              <Select.Option value="EXPIRY">Expiry</Select.Option>
              <Select.Option value="COUNT_VARIANCE">Count Variance</Select.Option>
              <Select.Option value="FOUND">Found Stock</Select.Option>
            </Select>
          </Form.Item>

          <Form.Item name="item_id" label="Item" rules={[{ required: true, message: "Select item" }]}>
            <Select showSearch optionFilterProp="children" placeholder="Select item">
              {items.map((i) => (
                <Select.Option key={i.id} value={i.id}>{i.code} - {i.name}</Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="direction" label="Direction" rules={[{ required: true }]}>
                <Select>
                  <Select.Option value="IN">IN (Increase)</Select.Option>
                  <Select.Option value="OUT">OUT (Decrease)</Select.Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="quantity" label="Quantity" rules={[{ required: true }]}>
                <InputNumber min={0.001} style={{ width: "100%" }} placeholder="Qty" />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item name="unit_cost" label="Unit Cost (Optional)">
            <InputNumber min={0} style={{ width: "100%" }} placeholder="0.00" />
          </Form.Item>

          <Form.Item name="remarks" label="Remarks">
            <Input.TextArea rows={2} placeholder="Reason or inspection notes..." />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
